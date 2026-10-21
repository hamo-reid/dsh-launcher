/**
 * Plugin update detection.
 *
 * npm-backed plugins are checked against the registry's `latest` dist-tag. Other
 * origins (github-only, local folder) have no reliable version source and are
 * surfaced as `manual` — the UI points the user at a manual download instead.
 *
 * Checks are bounded (a small concurrency pool + per-package error isolation) and
 * memoized in memory with a short TTL, so entering the plugin page repeatedly
 * does not hammer the registry. `refresh: true` forces a re-check.
 */
import { fetchPackageVersions } from './npm.ts'
import { registryBase } from './registry.ts'
import { buildInstalledOverview } from './overview.ts'
import { readPluginSourceSpec } from './sources.ts'
import { parseSource } from './git-source.ts'
import { compareVersionsLoose, latestPackageVersion } from '../shared/version.ts'
import { githubAuthHeaders, noteGithubResponse, resetGithubRateLimit } from '../github/auth.ts'
import { createKeyedCache } from '../shared/keyed-cache.ts'
import { logger } from '../shared/logger.ts'
import type { DshScope } from '../profile/appState.ts'
import type { InstalledOverviewRow, PluginOrigin, PluginUpdateInfo } from '../../../shared/types.ts'

/** How long a check result is reused before another manual check refetches. */
const CACHE_TTL_MS = 5 * 60_000
/** Max concurrent registry / API lookups (keeps us well under rate limits). */
const CONCURRENCY = 4
/** Per-request ceiling for a GitHub tags lookup. */
const GITHUB_TAGS_TIMEOUT_MS = 10_000

/** Whether `latest` is newer than every version we already have. An empty or
 * unparseable version never counts as "we have it", so it can't mask an update. */
export function isUpdateAvailable(latest: string | undefined, versions: string[]): boolean {
  if (latest === undefined || latest.trim() === '') return false
  return versions.every(v => v.trim() === '' || compareVersionsLoose(latest, v) > 0)
}

/** The `owner/repo` of a git source spec — `github:o/r[#path:…]`, a `gitlab:` /
 * `gitea:` / `gitee:` shorthand, or a `git+https://…` URL — or `undefined`. Pure.
 * Only the repo path is returned: which API answers for it is decided by the
 * caller from the spec's own forge. */
export function repoFromSpec(spec: string | undefined): string | undefined {
  if (spec === undefined) return undefined
  return parseSource(spec).repo
}

/** Whether an origin is a git forge — the origins that have no registry entry. */
function isForgeOrigin(origin: PluginOrigin): origin is 'github' | 'gitlab' | 'gitea' | 'gitee' {
  return origin === 'github' || origin === 'gitlab' || origin === 'gitea' || origin === 'gitee'
}

/** Build one plugin's update info from its overview row + resolved latest. Pure.
 * `manual` means the origin cannot be auto-checked (local, or a git install whose
 * tags could not be resolved — only GitHub has a tag API we call today). */
export function toUpdateInfo(
  row: Pick<InstalledOverviewRow, 'name' | 'versions' | 'usage'> & { origin: PluginOrigin },
  latest: string | undefined,
): PluginUpdateInfo {
  const applied = [...new Set(row.usage.map(u => u.version).filter((v): v is string => v !== undefined && v !== ''))]
  const archived = [...row.versions]
  const manual = row.origin === 'local' || (isForgeOrigin(row.origin) && latest === undefined)
  return {
    name: row.name,
    origin: row.origin,
    applied,
    archived,
    ...(latest !== undefined ? { latest } : {}),
    updateAvailable: latest !== undefined && isUpdateAvailable(latest, [...applied, ...archived]),
    manual,
  }
}

/** Resolve a package's latest installable version from npm, or `undefined` when
 * the package is unreachable / has no versions (a github-only name 404s here). */
async function latestNpmVersion(name: string): Promise<string | undefined> {
  try {
    const info = await fetchPackageVersions(name)
    return latestPackageVersion(info)
  } catch {
    return undefined
  }
}

/** The highest semver-looking tag of a GitHub repo, or `undefined` (rate limit /
 * 404 / no semver tags). Sends the user's token when configured (60 req/h
 * unauthenticated → 5000 authenticated); a rate-limited response is recorded so
 * the UI can explain why github-origin plugins fell back to "manual". */
async function latestGithubTag(repo: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=100`, {
      headers: githubAuthHeaders(),
      signal: AbortSignal.timeout(GITHUB_TAGS_TIMEOUT_MS),
    })
    if (!res.ok) {
      noteGithubResponse(res)
      return undefined
    }
    const tags = await res.json() as { name?: unknown }[]
    const versions = tags
      .map(tag => (typeof tag.name === 'string' ? tag.name.replace(/^v/i, '') : ''))
      .filter(v => /^\d+\.\d+\.\d+/.test(v))
    return versions.length === 0 ? undefined : versions.sort(compareVersionsLoose)[versions.length - 1]
  } catch {
    return undefined
  }
}

/** One entry: the key covers the whole store's plugin set, so a changed signature
 * replaces the previous result rather than accumulating beside it. */
const updateCache = createKeyedCache<PluginUpdateInfo[]>({ max: 1, ttlMs: CACHE_TTL_MS })

/** A cache key capturing the exact inputs a result depends on.
 *
 * The registry is one of them: a version list comes from a HOST, and switching
 * `registryUrl` (a private mirror, an air-gapped one) changes what "latest" means
 * for every row at once. Without it in the key, the previous host's verdicts keep
 * being served for the rest of the TTL — five minutes of "no update" that is
 * simply about a different registry. */
function cacheKey(storeDir: string, rows: InstalledOverviewRow[]): string {
  const sig = rows
    .map(r => `${r.name}|${r.versions.join(',')}|${r.usage.map(u => u.version ?? '').join(',')}`)
    .sort()
    .join(';')
  return `${storeDir}\u0000${registryBase()}\u0000${sig}`
}

/** Check every store-installed plugin for an available update. Results are
 * cached for {@link CACHE_TTL_MS}; pass `refresh: true` to bypass the cache. */
export async function checkPluginUpdates(
  dshes: DshScope[],
  storeDir: string,
  opts: { refresh?: boolean } = {},
): Promise<PluginUpdateInfo[]> {
  // Only store-archived plugins are launcher-managed and update-checkable;
  // official/local-link/external rows are not.
  const rows = buildInstalledOverview(dshes, storeDir).filter(r => r.inStore === true)
  const key = cacheKey(storeDir, rows)
  const cached = opts.refresh === true ? undefined : updateCache.peek(key)
  if (cached !== undefined) return cached

  // A fresh network check starts with a clean rate-limit flag.
  resetGithubRateLimit()
  const list: PluginUpdateInfo[] = new Array<PluginUpdateInfo>(rows.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= rows.length) return
      const row = rows[i]
      const origin: PluginOrigin = row.origin ?? 'unknown'
      let latest: string | undefined
      if (origin === 'npm' || origin === 'unknown') {
        // `unknown` = a pre-tracking archive, usually npm.
        latest = await latestNpmVersion(row.name)
      } else if (origin === 'github') {
        // Only GitHub exposes a tags API we consume; GitLab/Gitea/Gitee installs
        // stay `manual` rather than being asked for a version we cannot read.
        const repo = repoFromSpec(readPluginSourceSpec(storeDir, row.name))
        if (repo !== undefined) latest = await latestGithubTag(repo)
      }
      // `local` — and a git install whose repo cannot be resolved — stay manual.
      list[i] = toUpdateInfo({ ...row, origin }, latest)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker))

  updateCache.set(key, list)
  const updatable = list.filter(x => x.updateAvailable).length
  if (updatable > 0) logger.info(`plugin updates: ${updatable}/${list.length} available`)
  return list
}
