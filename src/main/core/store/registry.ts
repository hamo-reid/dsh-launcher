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
import { matchesScope, normalizeScope, parseRegistry } from './npmrc.ts'

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
  const parsed = parseRegistry(raw)
  if (parsed !== undefined) return parsed
  if (typeof raw === 'string' && raw.trim() !== '') {
    logger.warn(`registry: "${raw.trim()}" is not a usable http(s) registry URL; using ${PUBLIC_REGISTRY}`)
  }
  return PUBLIC_REGISTRY
}

/**
 * The registry a *specific package* resolves from.
 *
 * Same invariant as above, one step finer: the registry that answers "which
 * versions exist" has to be the registry the package is installed from. It used
 * to be one global answer, which meant a private registry could only ever be the
 * only registry — every public dependency had to be proxied by it or the install
 * failed. A scope narrows the configured registry to the packages that actually
 * live there and leaves everything else on the public one.
 *
 * No scope means the configured registry answers for every package, which is
 * both the pre-existing behaviour and the correct reading of an internal mirror.
 */
export function registryFor(packageName: string): string {
  const base = registryBase()
  const rawScope = loadSettings().registryScope
  const scope = normalizeScope(rawScope)
  if (scope === undefined) {
    // An unusable scope adds nothing to a value the user already set, so the
    // configured registry answers for everything — the unset meaning. It is
    // said once, because this runs per package during an update check.
    if (typeof rawScope === 'string' && rawScope.trim() !== '' && warnedScope !== rawScope) {
      warnedScope = rawScope
      logger.warn(`registry: "${rawScope.trim()}" is not a usable package scope; every package resolves from ${base}`)
    }
    return base
  }
  return matchesScope(packageName, scope) ? base : PUBLIC_REGISTRY
}

/** The last unusable scope value warned about (see `registryFor`). */
let warnedScope: string | undefined

/**
 * The registry a SEARCH runs against.
 *
 * Deliberately **not** `registryBase()`, and the distinction is the whole point:
 * search is discovery, resolution is installation. A private registry is a place
 * packages are fetched from *by name*; the standard registry protocol puts no
 * obligation on it to implement `/-/v1/search`, and plenty do not. Routing search
 * there turned "I configured a private source" into "the download centre stopped
 * working" — one setting quietly breaking an unrelated feature.
 *
 * Everything package-scoped still routes through `registryFor`, so a private
 * plugin is still resolved (and installed) from the private source. Only the
 * catalogue you browse stays public, which is also the only catalogue that can
 * answer a keyword.
 */
export const SEARCH_REGISTRY = PUBLIC_REGISTRY

/**
 * A stable description of the current routing, for cache keys.
 *
 * A version list comes from a HOST, and both halves of the routing decide which
 * host that is: changing the registry, or narrowing it to a scope, changes what
 * `latest` means for a whole set of packages at once. Without this in a cache
 * key, a previous host's verdicts keep being served for the rest of the TTL —
 * minutes of "no update available" that are simply about a different registry.
 */
export function registrySignature(): string {
  return `${registryBase()}\u0000${loadSettings().registryScope ?? ''}`
}