/**
 * Materialize the registry table's npm configuration on disk and hand pnpm the
 * environment that points at it.
 *
 * Written as a file rather than as `pnpm --registry=…` flags because a token has
 * to be attached per host+path: npm's configuration is the only place that
 * spelling exists, and it is what registries document.
 *
 * The file describes the WHOLE table, not just the entries that have tokens.
 * pnpm must route the way the launcher routes; a file that mentioned only the
 * authenticated entries would install `@scope/*` from the public registry while
 * the version list came from somewhere else. So: **configuring any registry
 * takes over pnpm's registry selection** — and that is also the one cost, since
 * the user's own npm configuration is no longer read while entries exist.
 *
 * The token is never in the file — it names an environment variable per entry
 * (`store/registry-auth.ts` supplies the values), so a copy of the file is not a
 * copy of any credential.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../shared/logger.ts'
import { buildNpmrc, registryEnv as envFor } from './npmrc.ts'
import { privateSources, registryTokenEnv } from './registry-auth.ts'
import { PUBLIC_REGISTRY, mirrorRegistry } from './registry.ts'

/** The file name inside the directory the caller owns. */
export const REGISTRY_NPMRC = 'npmrc'

/** Rewrite `<dir>/npmrc` when it differs from what the settings describe, and
 * return the environment additions pnpm needs. Returns `{}` — meaning "use the
 * user's own npm configuration" — when no registry is configured, and also when
 * one is but the file cannot be written: an install must not fail because a
 * convenience file could not be produced. */
export function applyRegistryConfig(dir: string): Record<string, string> {
  const sources = privateSources()
  // A mirror alone is a valid configuration: it writes `registry=` and nothing
  // else, and that is exactly what makes every package come from it. Returning
  // early here would leave the mode silently off.
  const mirror = mirrorRegistry()
  if (sources.length === 0 && mirror === undefined) return {}
  const defaultRegistry = mirror?.url ?? PUBLIC_REGISTRY
  const text = buildNpmrc(sources, { defaultRegistry })
  if (text === undefined) {
    logger.warn('registry: the configured entries cannot be described; pnpm runs with the user config')
    return {}
  }
  const file = join(dir, REGISTRY_NPMRC)
  try {
    mkdirSync(dir, { recursive: true })
    // Read-before-write: every pnpm spawn calls this, and the settings rarely
    // change. A rewrite per spawn would churn mtime for no reason.
    if (readExisting(file) !== text) writeFileSync(file, text, 'utf8')
  } catch (error) {
    logger.warn(`registry: could not write ${file}: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
  return envFor({ configPath: file, tokens: registryTokenEnv() })
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
