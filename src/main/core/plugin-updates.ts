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
import { buildInstalledOverview } from './store-overview.ts'
import { readPluginSourceSpec } from './store-sources.ts'
import { compareVersionsLoose } from './version.ts'
import { logger } from './logger.ts'
import type { DshScope } from './appState.ts'
import type { InstalledOverviewRow, PluginOrigin, PluginUpdateInfo } from '../../shared/types.ts'

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

/** The `owner/repo` of a `github:owner/repo[#path:…]` spec, or `undefined`. Pure. */
export function repoFromSpec(spec: string | undefined): string | undefined {
  if (spec === undefined) return undefined
  const m = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(spec.trim())
  return m?.[1]
}

/** Build one plugin's update info from its overview row + resolved latest. Pure.
 * `manual` means the origin cannot be auto-checked (local, or a github install
 * whose tags could not be resolved). */
export function toUpdateInfo(
  row: Pick<InstalledOverviewRow, 'name' | 'versions' | 'usage'> & { origin: PluginOrigin },
  latest: string | undefined,
): PluginUpdateInfo {
  const applied = [...new Set(row.usage.map(u => u.version).filter((v): v is string => v !== undefined && v !== ''))]
  const archived = [...row.versions]
  const manual = row.origin === 'local' || (row.origin === 'github' && latest === undefined)
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
    return info.distTags.latest ?? info.versions[info.versions.length - 1]
  } catch {
    return undefined
  }
}

/** The highest semver-looking tag of a GitHub repo, or `undefined` (rate limit /
 * 404 / no semver tags). Unauthenticated GitHub allows 60 req/h — fine for the
 * handful of github-installed plugins a check inspects. */
async function latestGithubTag(repo: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=100`, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(GITHUB_TAGS_TIMEOUT_MS),
    })
    if (!res.ok) return undefined
    const tags = await res.json() as { name?: unknown }[]
    const versions = tags
      .map(tag => (typeof tag.name === 'string' ? tag.name.replace(/^v/i, '') : ''))
      .filter(v => /^\d+\.\d+\.\d+/.test(v))
    return versions.length === 0 ? undefined : versions.sort(compareVersionsLoose)[versions.length - 1]
  } catch {
    return undefined
  }
}

let cache: { at: number; key: string; list: PluginUpdateInfo[] } | null = null

/** A cache key capturing the exact inputs a result depends on. */
function cacheKey(storeDir: string, rows: InstalledOverviewRow[]): string {
  const sig = rows
    .map(r => `${r.name}|${r.versions.join(',')}|${r.usage.map(u => u.version ?? '').join(',')}`)
    .sort()
    .join(';')
  return `${storeDir}\u0000${sig}`
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
  if (opts.refresh !== true && cache !== null && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.list
  }

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
        const repo = repoFromSpec(readPluginSourceSpec(storeDir, row.name))
        if (repo !== undefined) latest = await latestGithubTag(repo)
      }
      // `local` — and a github install whose repo cannot be resolved — stay manual.
      list[i] = toUpdateInfo({ ...row, origin }, latest)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker))

  cache = { at: Date.now(), key, list }
  const updatable = list.filter(x => x.updateAvailable).length
  if (updatable > 0) logger.info(`plugin updates: ${updatable}/${list.length} available`)
  return list
}
