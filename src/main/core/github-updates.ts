/**
 * Launcher self-update detection against the GitHub releases API. The About page
 * checks whether a newer release exists than the installed version. The raw
 * payload normalisation (strip the leading `v`, map the fields) and the "pick the
 * semantically-highest tag" logic are exported separately so unit tests exercise
 * them without any network; only `checkAppUpdate` performs the HTTP fetch.
 *
 * Handling includes prerelease tags: the installed app ships as a prerelease
 * beta, so a newer beta must be detected too (the `/releases/latest` endpoint
 * would skip prereleases).
 */
import type { AppRelease } from '../../shared/types.ts'
import { compareVersionsLoose } from './version.ts'
import { logger } from './logger.ts'

/** GitHub releases API list endpoint. `per_page` up to 100; tags order newest-first. */
const RELEASES_URL = 'https://api.github.com/repos/{repo}/releases?per_page=100'
const FETCH_TIMEOUT_MS = 10_000

/** Raw shape of one GitHub release API object (the fields we read). */
export interface RawGitHubRelease {
  tag_name?: string
  html_url?: string
  published_at?: string
  prerelease?: boolean
}

/** Normalise one raw release into the display shape, stripping a leading `v`. */
export function normalizeRelease(raw: RawGitHubRelease): AppRelease | null {
  const tag = typeof raw.tag_name === 'string' ? raw.tag_name.trim().replace(/^v/, '') : ''
  if (tag === '') return null
  return {
    tag,
    version: tag,
    url: typeof raw.html_url === 'string' && raw.html_url !== '' ? raw.html_url : '',
    ...(typeof raw.published_at === 'string' && raw.published_at !== '' ? { publishedAt: raw.published_at } : {}),
  }
}

/** Pick the semantically-highest release from a normalised list (prerelease-aware),
 * or `null` when there is none. Releases whose tag is unparseable as a version are
 * skipped conservatively (they can never be "newer"). */
export function pickLatestRelease(list: AppRelease[]): AppRelease | null {
  let best: AppRelease | null = null
  for (const release of list) {
    if (best === null || compareVersionsLoose(release.tag, best.tag) > 0) best = release
  }
  return best
}

/** Fetch the repo's release list from the GitHub API. */
async function fetchGitHubReleases(repo: string): Promise<AppRelease[]> {
  logger.debug(`github releases: "${repo}"`)
  const res = await fetch(RELEASES_URL.replace('{repo}', repo), {
    headers: { 'User-Agent': 'dsh-launcher', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GitHub releases 查询失败：HTTP ${res.status}`)
  const data = (await res.json()) as RawGitHubRelease[]
  if (!Array.isArray(data)) throw new Error('GitHub releases 返回异常')
  return data.map(normalizeRelease).filter((r): r is AppRelease => r !== null)
}

/**
 * Check for a newer launcher release. Returns the current version and the highest
 * release newer than it (or `latest: null` when up to date). Throws on network /
 * API failure so the IPC layer can surface a retryable error.
 */
export async function checkAppUpdate(current: string): Promise<{ current: string; latest: AppRelease | null }> {
  const releases = await fetchGitHubReleases('hamo-reid/dsh-launcher')
  const latest = pickLatestRelease(releases)
  if (latest === null || compareVersionsLoose(latest.tag, current) <= 0) {
    return { current, latest: null }
  }
  return { current, latest }
}