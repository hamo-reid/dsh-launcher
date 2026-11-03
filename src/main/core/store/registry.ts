/**
 * Which npm registry answers for which package.
 *
 * The model is the standard one, not any vendor's: a registry is a URL plus an
 * optional **scope**. A scoped entry owns `@scope/*` and nothing else; the one
 * entry *without* a scope answers for everything no other scope claims (the
 * internal-mirror case). Anything nobody claims falls through to the public
 * registry. Because at most one entry may be unscoped — the writer refuses a
 * second one, and `normalizeSettings` drops it — this table always has exactly
 * one answer per package name.
 *
 * Two invariants live here, both learned the hard way:
 * - **A version list and the install must come from the same host.** That is why
 *   `registryFor` is the single routing decision and why the pnpm side is
 *   generated from the same table (`store/registry-config.ts`).
 * - **Search is not routing.** Keyword search is discovery, and a private
 *   registry is under no obligation to implement `/-/v1/search` — routing search
 *   there turned "I configured a private source" into "the download centre
 *   stopped working". Only resolution follows the table.
 */
import { loadSettings } from '../settings/settings.ts'
import { throwE } from '../shared/errors.ts'
import { logger } from '../shared/logger.ts'
import { matchesScope, normalizeScope, parseRegistry } from './npmrc.ts'
import type { RegistryEntryRecord } from '../settings/normalize.ts'
import type { RegistrySource } from '../../../shared/types.ts'

/** The public npm registry — the answer for anything no scope claims. */
export const PUBLIC_REGISTRY = 'https://registry.npmjs.org'

/**
 * The configured entries, with URLs normalized and unusable ones dropped.
 *
 * Validated rather than trusted: a value arrives through a text field and a
 * settings import. An unusable URL warns once per value (this runs per package
 * during an update check) and is skipped, because building a `fetch` against a
 * nonsense scheme is worse than not offering that registry at all.
 */
export function registries(): RegistryEntryRecord[] {
  const out: RegistryEntryRecord[] = []
  for (const entry of loadSettings().registries ?? []) {
    const url = parseRegistry(entry.url)
    if (url === undefined) {
      if (warnedUrls.get(entry.id) !== entry.url) {
        warnedUrls.set(entry.id, entry.url)
        logger.warn(`registry: "${entry.url}" is not a usable http(s) URL; entry "${entry.label}" is ignored`)
      }
      continue
    }
    // Every scope is validated independently: one unusable value must not cost the
    // entry the scopes that are fine.
    const scopes = (entry.scopes ?? [])
      .map(scope => normalizeScope(scope))
      .filter((scope): scope is string => scope !== undefined)
    out.push({ ...entry, url, scopes })
  }
  return out
}

/** The configured entries as stored, for the settings editor and for anything
 * that must not lose sight of an entry. An entry with an unusable URL is still
 * listed — hiding it would leave the user unable to fix it — while `registries()`
 * is what routing and pnpm see. */
export function registryEntries(): RegistryEntryRecord[] {
  return loadSettings().registries ?? []
}

/** Last-unusable URLs warned about, so a per-package path warns once. */
const warnedUrls = new Map<string, string>()


/** One entry by id, or `undefined`. */
export function registryById(id: string): RegistryEntryRecord | undefined {
  return registries().find(entry => entry.id === id)
}

/** The entry that answers for a package, or `undefined` when that is the public
 * registry. Same decision as `registryFor`, kept in one place so a recorded origin
 * can never disagree with where the install actually went. */
export function registryEntryFor(packageName: string): RegistryEntryRecord | undefined {
  // One candidate per (entry, scope) pair: an entry owning several scopes competes
  // with itself, and the longest match decides which of ITS scopes applies.
  const candidates = registries().flatMap(entry =>
    (entry.scopes ?? []).map(scope => ({ entry, scope })),
  )
  const matched = candidates
    .filter(candidate => matchesScope(packageName, candidate.scope))
    .sort((a, b) => b.scope.length - a.scope.length)
  return matched[0]?.entry
}

/**
 * The registry a package resolves from: the entry whose scope matches, else the
 * public registry.
 *
 * There is deliberately no "fallback" entry. An entry with no scope would answer
 * for every package no other scope claims, which made two configured sources a
 * question with two answers — and a person cannot tell from a list which one a
 * given package will use. A scope is required instead: a source is always about a
 * set of packages, and everything outside every set comes from npm.
 */
export function registryFor(packageName: string): string {
  return registryEntryFor(packageName)?.url ?? PUBLIC_REGISTRY
}

/**
 * The registry named by an explicit choice.
 *
 * `auto` is the routing above and stays the default: installs and update checks
 * have no business overriding it. `public` and `reg:<id>` come from the download
 * page, where a person *asserts* where to look — and an assertion must not be
 * quietly rewritten into a derivation. A name outside the scope of the registry
 * that was chosen is an answer to give back ("not in there"), not a reason to go
 * ask somewhere else.
 *
 * Throws the coded error when the named registry does not exist, rather than
 * falling back to public and appearing to answer from the wrong place.
 */
export function registryForSource(packageName: string, source: RegistrySource = 'auto'): string {
  if (source === 'public') return PUBLIC_REGISTRY
  if (source.startsWith('reg:')) {
    const entry = registryById(source.slice(4))
    if (entry === undefined) throwE('registry.notConfigured')
    return entry.url
  }
  return registryFor(packageName)
}


/**
 * The registry a SEARCH runs against: always the public catalogue.
 *
 * Search has no package name to route by, and a private registry is not required
 * to answer `/-/v1/search` (the ones that do not answer 404). Discovery therefore
 * does not follow the table; resolution does.
 */
export const SEARCH_REGISTRY = PUBLIC_REGISTRY

/**
 * A stable description of the current routing, for cache keys.
 *
 * A version list comes from a HOST, and the whole table decides which host that
 * is: adding, removing or re-scoping an entry changes what `latest` means for a
 * set of packages at once. Without this in a cache key, a previous table's
 * verdicts keep being served for the rest of the TTL — minutes of "no update
 * available" that are simply about different registries.
 */
export function registrySignature(): string {
  return registries()
    .map(entry => `${entry.id}\u0000${entry.url}\u0000${(entry.scopes ?? []).join(',')}`)
    .sort()
    .join('\u0001')
}
