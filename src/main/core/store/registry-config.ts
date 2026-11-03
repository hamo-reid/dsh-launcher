/**
 * Materialize the private registry's npm configuration on disk and hand pnpm the
 * environment that points at it.
 *
 * Written as a file rather than as `pnpm --registry=…` flags because a token has
 * to be attached per host+path: npm's configuration is the only place that
 * spelling exists, and it is what the registry's own documentation tells users to
 * write.
 *
 * Two deliberate limits:
 * - **Nothing is written without a token.** A configured registry that needs no
 *   credential is already covered by the user's own npm configuration, and
 *   replacing that file would silently drop whatever else they had in it (a
 *   corporate proxy, another registry's auth). The token is the one thing their
 *   configuration cannot contain.
 * - **The token is never in the file** — it names an environment variable
 *   (`store/registry-auth.ts` supplies the value to the child process), so a copy
 *   of this file is not a copy of the credential.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../shared/logger.ts'
import { buildNpmrc, registryEnv as envFor } from './npmrc.ts'
import { privateRegistrySource, REGISTRY_TOKEN_ENV, registryToken } from './registry-auth.ts'
import { PUBLIC_REGISTRY } from './registry.ts'

/** The file name inside the directory the caller owns. */
export const REGISTRY_NPMRC = 'npmrc'

/** Rewrite `<dir>/npmrc` when it differs from what the settings describe, and
 * return the environment additions pnpm needs. Returns `{}` — meaning "use the
 * user's own npm configuration" — whenever the feature is not in play, and also
 * when it is in play but cannot be set up: an install must not fail because a
 * convenience file could not be written. */
export function applyRegistryConfig(dir: string): Record<string, string> {
  const source = privateRegistrySource()
  // No credential means nothing to add: this feature exists to make a private
  // registry reachable, not to take over registry selection.
  if (source === undefined || source.tokenEnv === undefined) return {}
  const text = buildNpmrc(source, { defaultRegistry: PUBLIC_REGISTRY })
  if (text === undefined) {
    logger.warn('private registry: the configured source cannot be described; pnpm runs with the user config')
    return {}
  }
  const file = join(dir, REGISTRY_NPMRC)
  try {
    mkdirSync(dir, { recursive: true })
    // Read-before-write: every pnpm spawn calls this, and the settings rarely
    // change. A rewrite per spawn would churn mtime for no reason.
    if (readExisting(file) !== text) writeFileSync(file, text, 'utf8')
  } catch (error) {
    logger.warn(`private registry: could not write ${file}: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
  return envFor({ configPath: file, tokenEnv: REGISTRY_TOKEN_ENV, token: registryToken() })
}

/** The file's current text, or `undefined` when it is absent or unreadable (both
 * mean "write it"). */
function readExisting(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}
