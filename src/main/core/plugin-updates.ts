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
import { compareVersionsLoose } from './version.ts'
import { logger } from './logger.ts'
import type { DshScope } from './appState.ts'
import type { InstalledOverviewRow, PluginOrigin, PluginUpdateInfo } from '../../shared/types.ts'

/** How long a check result is reused before another manual check refetches. */
const CACHE_TTL_MS = 5 * 60_000
/** Max concurrent registry lookups (keeps us well under npm rate limits). */
const CONCURRENCY = 4

/** Whether `latest` is newer than every version we already have. An empty or
 * unparseable version never counts as "we have it", so it can't mask an update. */
export function isUpdateAvailable(latest: string | undefined, versions: string[]): boolean {
  if (latest === undefined || latest.trim() === '') return false
  return versions.every(v => v.trim() === '' || compareVersionsLoose(latest, v) > 0)
}

/** Build one plugin's update info from its overview row + resolved latest. Pure. */
export function toUpdateInfo(
  row: Pick<InstalledOverviewRow, 'name' | 'versions' | 'usage'> & { origin: PluginOrigin },
  latest: string | undefined,
): PluginUpdateInfo {
  const applied = [...new Set(row.usage.map(u => u.version).filter((v): v is string => v !== undefined && v !== ''))]
  const archived = [...row.versions]
  const manual = row.origin === 'github' || row.origin === 'local'
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
      // npm and untracked (`unknown`, likely a pre-tracking npm archive) are
      // queried; github/local are manual.
      const latest = origin === 'npm' || origin === 'unknown' ? await latestNpmVersion(row.name) : undefined
      list[i] = toUpdateInfo({ ...row, origin }, latest)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker))

  cache = { at: Date.now(), key, list }
  const updatable = list.filter(x => x.updateAvailable).length
  if (updatable > 0) logger.info(`plugin updates: ${updatable}/${list.length} available`)
  return list
}
