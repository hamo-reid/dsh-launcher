/**
 * Community-market catalog access: read the curated list published by
 * awesome-dsh-plugin, filter/sort it for display, and turn a catalog entry
 * into a trusted install target.
 *
 * The load pipeline is user-selectable (`official` = the canonical
 * `plugins.json` on GitHub Pages; `custom` = any mirror/side-channel URL the
 * user points at, e.g. a China-friendly proxy of the same shape). The choice
 * is persisted in app settings so it survives restarts. `installSpecFor` is
 * the security boundary: the renderer never passes an arbitrary spec — it
 * hands back a catalog `url`, and this module alone decides what is
 * installable. Nothing outside a catalog entry is ever accepted.
 */

import { loadSettings, saveSettings } from './settings.ts'
import { logger } from './logger.ts'
import type { MarketCatalog, MarketPage, MarketPlugin, MarketSort, MarketSource, MarketSourceState } from '../../shared/types.ts'

/** The canonical catalog address (GitHub Pages behind a CDN). */
export const MARKET_OFFICIAL_URL = 'https://awesome-dsh-plugin.com/plugins.json'

/** npm package names are plain, allowlisted shape — guards the store's package.json. */
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** How long to wait for the catalog. Generous: on a slow/remote link a 280 KB
 * catalog is not a 2-second job, and a provenance string that hangs is worse
 * than one that eventually resolves. */
const FETCH_TIMEOUT_MS = 15_000

// ── loading-route state ──────────────────────────────────────────────────────

/** The market's configured origin, falling back to `official`. */
export function marketSourceState(): MarketSourceState {
  const s = loadSettings()
  return {
    source: s.marketSource === 'custom' ? 'custom' : 'official',
    url: s.marketUrl ?? '',
  }
}

/** Persist the user's chosen loading route. Empty/malformed custom URLs are
 * refused so the UI can't save a route that would silently fail on next load. */
export function setMarketSourceState(next: MarketSourceState): boolean {
  const url = next.url.trim()
  if (next.source === 'custom' && !isHttpUrl(url)) return false
  saveSettings({
    ...loadSettings(),
    marketSource: next.source,
    ...(next.source === 'custom' ? { marketUrl: url } : {}),
  })
  // A route change must not serve a catalog fetched from another origin.
  forgetCatalog()
  return true
}

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false
  try {
    void new URL(value)
    return true
  } catch {
    return false
  }
}

/** Run one catalog source to ground, in order of preference. */
function sourcesFor(state: MarketSourceState): { url: string; label: string }[] {
  if (state.source === 'custom' && isHttpUrl(state.url)) {
    // The custom URL replaces the list, never heads it: a user pointing the
    // market at their own mirror does not want it quietly reverting to ours
    // when theirs is briefly unreachable.
    return [{ url: state.url, label: 'custom' }]
  }
  return [{ url: MARKET_OFFICIAL_URL, label: 'official' }]
}

// ── catalog fetch (validated, never served stale) ───────────────────────────

/** The last catalog an origin confirmed as current (via ETag/304). In-memory
 * only — a restart repays one full download, which costs nothing for a desktop
 * market, and a file would be one more thing that reads like the catalog. */
let served: { url: string; etag: string | null; modified: string | null; data: MarketCatalog } | null = null

/** Drop the memo so the next call is unconditional (route change / tests). */
export function forgetCatalog(): void {
  served = null
}

/** The single URL the current route resolves to (the first source in order). */
export function catalogUrl(state: MarketSourceState): string {
  return sourcesFor(state)[0].url
}

/** The memoized catalog for a URL, or null when absent or for a different URL.
 * A pure memory read — never touches the network. */
export function cachedCatalog(url: string): MarketCatalog | null {
  return served?.url === url ? served.data : null
}

/**
 * Serve the catalog for a route from the closest possible place. When we already
 * hold that URL in memory (and the caller did not ask to refresh) this returns
 * the memo as-is — so every pagination / search / sort is an instant local slice
 * with zero network. Otherwise it falls through to `loadMarket` (first access,
 * route change, or an explicit refresh), which revalidates over the network.
 */
export async function resolveMarket(state: MarketSourceState, refresh = false): Promise<MarketCatalog> {
  const url = catalogUrl(state)
  if (!refresh) {
    const mem = cachedCatalog(url)
    if (mem !== null) return mem
  }
  return loadMarket(state)
}

/** Parse + sanity-check a fetched catalog body. Throws with a terse reason. */
function asCatalog(value: unknown): MarketCatalog {
  const data = value as MarketCatalog
  if (data === null || typeof data !== 'object') throw new Error('the catalog came back empty')
  if (!Array.isArray(data.plugins)) throw new Error('the catalog did not carry a plugin list')
  // A catalog missing `categories` still works — the UI degrades to raw ids.
  if (data.categories !== undefined && (data.categories === null || typeof data.categories !== 'object')) {
    throw new Error('the catalog carried malformed categories')
  }
  return data
}

/**
 * Fetch the catalog for the current (or given) route. Revalidates with an
 * ETag / If-Modified-Since on every call so an origin-confirmed answer is
 * only ever reused when the origin just said it is still the one in hand.
 * A network failure is reported, never answered from memory.
 * @throws when no source produced a catalog (each source gets one attempt).
 */
export async function loadMarket(state = marketSourceState()): Promise<MarketCatalog> {
  const sources = sourcesFor(state)
  let last: unknown
  const started = Date.now()
  for (const { url, label } of sources) {
    try {
      const reusable = served?.url === url ? served : null
      const headers: Record<string, string> = {}
      if (reusable?.etag != null) headers['if-none-match'] = reusable.etag
      else if (reusable?.modified != null) headers['if-modified-since'] = reusable.modified
      // eslint-disable-next-line no-undef
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers })
      if (res.status === 304) {
        if (reusable === null) throw new Error('the catalog answered "not modified" with nothing to reuse')
        return reusable.data
      }
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
      const data = asCatalog(await res.json() as unknown)
      served = { url, etag: res.headers.get('etag'), modified: res.headers.get('last-modified'), data }
      return data
    } catch (error) {
      last = error
      logger.warn(`market catalog fetch failed (${label}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const reason = last instanceof Error ? last.message : 'unknown'
  const elapsed = String(Math.round((Date.now() - started) / 1000))
  throw new Error(`${reason} (${elapsed}s, after ${sources.length} source${sources.length > 1 ? 's' : ''})`)
}

// ── search / filter / sort (pure, unit-testable) ────────────────────────────

/** Sort plugins by a comparable key, putting `null`/unknown values LAST. */
function sortByDesc<T>(items: T[], key: (x: T) => number | null | undefined): T[] {
  return [...items].sort((a, b) => {
    const av = key(a)
    const bv = key(b)
    const an = av === null || av === undefined
    const bn = bv === null || bv === undefined
    if (an && bn) return 0
    if (an) return 1
    if (bn) return -1
    return bv - av
  })
}

/**
 * Filter (free-text + category) and sort the catalog. Pure — tests feed it a
 * canned catalog and assert the rows/order without any network.
 */
export function queryCatalog(
  catalog: MarketCatalog,
  opts: { q?: string; category?: string; sort?: MarketSort } = {},
): MarketPlugin[] {
  const q = (opts.q ?? '').trim().toLowerCase()
  const category = opts.category ?? ''
  const sort = opts.sort ?? 'stars'
  let rows = catalog.plugins
  if (category !== '') rows = rows.filter(p => p.category === category)
  if (q !== '') {
    rows = rows.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.owner.toLowerCase().includes(q) ||
      (p.npm ?? '').toLowerCase().includes(q) ||
      Object.values(p.description ?? {}).some(d => d.toLowerCase().includes(q)),
    )
  }
  if (sort === 'stars') return sortByDesc(rows, p => p.stars)
  if (sort === 'downloads') return sortByDesc(rows, p => p.downloads)
  // newest — most recent `added` first, unknown dates last.
  return sortByDesc(rows, p => (p.added === undefined ? null : Date.parse(p.added)))
}

// ── pagination (query then slice one page) ───────────────────────────────────

/** Upper bound on a single market page — a sanity cap, not a UX default. */
const MAX_PAGE_SIZE = 100
/** Default rows per page when the caller does not say otherwise. */
const DEFAULT_PAGE_SIZE = 20

function clampPageSize(n: number | undefined): number {
  const v = n ?? DEFAULT_PAGE_SIZE
  if (Number.isNaN(v) || v < 1) return 1
  return Math.min(Math.floor(v), MAX_PAGE_SIZE)
}

/**
 * Apply the query (q/category/sort) then slice a single page off the result.
 * Pure — pageCatalog(catalog, opts) → MarketPage, so the renderer can be handed
 * a bounded slice and the pagination total without ever seeing the full list.
 * `page` is clamped into [1, lastPage] so a stale page ref (after a narrower
 * filter) never yields an empty window.
 */
export function pageCatalog(
  catalog: MarketCatalog,
  opts: { q?: string; category?: string; sort?: MarketSort; page?: number; pageSize?: number } = {},
): MarketPage {
  const rows = queryCatalog(catalog, { q: opts.q, category: opts.category, sort: opts.sort })
  const pageSize = clampPageSize(opts.pageSize)
  const total = rows.length
  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1)), lastPage)
  return {
    updated: catalog.updated,
    total,
    categories: catalog.categories ?? {},
    items: rows.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
  }
}

// ── install target resolution (the security boundary) ───────────────────────

/**
 * Turn a curated catalog entry into the exact spec the pnpm store can install.
 *
 * Order mirrors dsh-market's "registry tarballs beat full-repo GitHub": a
 * verified npm name wins (smaller, prebuilt, CDN-served); GitHub-only plugins
 * fall back to a `github:owner/repo[#path:/sub]` spec. Every input is derived
 * from the entry itself — nothing typed by the user reaches this call.
 *
 * @returns the install spec, or null when the entry has no usable source.
 */
export function installSpecFor(entry: Pick<MarketPlugin, 'url' | 'npm'>): string | null {
  if (typeof entry.npm === 'string' && entry.npm !== '' && NPM_NAME_RE.test(entry.npm)) {
    return entry.npm
  }
  const repo = parseGitHubUrl(entry.url)
  if (repo === null) return null
  const base = repo.repo // owner/name, original case
  return repo.subpath === null ? `github:${base}` : `github:${base}#path:/${repo.subpath}`
}

/** Parse a catalog GitHub URL: `https://github.com/o/r[/tree//branch/sub/path]`. */
function parseGitHubUrl(url: string): { repo: string; subpath: string | null } | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(url)
  if (m === null) return null
  const subpath = m[2] ?? null
  if (subpath !== null && !validSubpath(subpath)) return null
  return { repo: m[1], subpath }
}

/** Reject `..` / empty path segments — they would escape the repo in #path:. */
function validSubpath(subpath: string): boolean {
  if (!/^[A-Za-z0-9_./-]+$/.test(subpath)) return false
  return !subpath.split('/').some(seg => seg === '' || seg === '.' || seg === '..')
}