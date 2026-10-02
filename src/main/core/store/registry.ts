/**
 * Which npm registry the launcher itself resolves versions from.
 *
 * One invariant, stated once because two call paths used to break it: **choosing
 * a version and fetching the package must ask the SAME registry.** `npmSearch`
 * and `fetchPackageVersions` are the launcher's own `fetch` calls, and pnpm is a
 * separate process reading the user's `.npmrc` — so a private deployment could
 * resolve `latest` against `registry.npmjs.org` and then install from its own
 * mirror. The visible consequences are that an air-gapped install cannot even
 * START (the version lookup throws before pnpm is ever spawned) and that a mirror
 * whose `latest` disagrees with the public one installs a version the user did
 * not ask for.
 *
 * `core/dsh/install.ts` resolves both the initial install and the update check
 * through `fetchPackageVersions`, so pointing this at a private registry is what
 * makes an air-gapped dsh install work at all — there is no second place to
 * configure and no separate knob for dsh.
 *
 * This module reads settings directly, unlike `core/dsh/pnpm.ts` which keeps its
 * dependencies injectable because it drives a child process. It stays pure of
 * HTTP: it answers "which URL", and `npm.ts` owns the request.
 */

import { loadSettings } from '../settings/settings.ts'
import { logger } from '../shared/logger.ts'

/** The public npm registry — what both call sites used before this setting. */
export const PUBLIC_REGISTRY = 'https://registry.npmjs.org'

/**
 * The registry base to build request URLs from: the configured one, or the
 * public one. Never has a trailing slash.
 *
 * A configured value arrives through a text field and a settings import, so it is
 * validated rather than trusted: an unusable value warns and falls back, because
 * silently building a `fetch` against a nonsense scheme is worse, and because a
 * deployment that asked for a mirror and quietly got the public one is exactly
 * the confusion this setting exists to end.
 */
export function registryBase(): string {
  const raw = loadSettings().registryUrl
  if (typeof raw !== 'string' || raw.trim() === '') return PUBLIC_REGISTRY
  const trimmed = raw.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    logger.warn(`registry: "${trimmed}" is not a URL; using ${PUBLIC_REGISTRY}`)
    return PUBLIC_REGISTRY
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    logger.warn(`registry: "${trimmed}" is not an http(s) URL; using ${PUBLIC_REGISTRY}`)
    return PUBLIC_REGISTRY
  }
  return trimmed
}