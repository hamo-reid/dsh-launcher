/**
 * Persisted overview filter/sort config for the Plugins page. Renderer-local UI
 * preference (localStorage), kept out of the main-process settings so it never
 * round-trips through IPC. Parsing is pure and unit-tested; every value is
 * validated against an allow-list so a stale / hand-edited store degrades to
 * defaults instead of throwing.
 *
 * Each facet carries a mode: `include` keeps rows that match one of its values,
 * `exclude` drops them. Within a facet the values OR; across facets they AND.
 */
import type { InstalledOverviewRow, PluginKind, PluginOrigin, PluginProvenance, PluginUpdateInfo } from '../../../shared/types.ts'

/** Overview bucket filters (classification). */
export type Bucket = 'all' | 'used' | 'unused' | 'update' | 'template'

/** Overview card sort orders. */
export type SortKey = 'name' | 'size' | 'versions' | 'usage'
export type SortDir = 'asc' | 'desc'

/** Whether a facet's values are a whitelist or a blacklist. */
export type FacetMode = 'include' | 'exclude'

/** One filter dimension: a mode plus its selected values. */
export interface Facet<T extends string> {
  mode: FacetMode
  values: T[]
}

export interface StoredFilters {
  bucket: Bucket
  origin: Facet<PluginOrigin>
  kind: Facet<PluginKind>
  provenance: Facet<PluginProvenance>
  sortKey: SortKey
  sortDir: SortDir
}

export const FILTER_KEY = 'pm.plugins.overview.filters'

export const DEFAULT_FILTERS: StoredFilters = {
  bucket: 'all',
  origin: { mode: 'include', values: [] },
  kind: { mode: 'include', values: [] },
  provenance: { mode: 'include', values: [] },
  sortKey: 'name',
  sortDir: 'asc',
}

const ALL_BUCKETS: readonly Bucket[] = ['all', 'used', 'unused', 'update', 'template']
const ALL_ORIGINS: readonly PluginOrigin[] = ['npm', 'github', 'local', 'unknown']
const ALL_KINDS: readonly PluginKind[] = ['bundle', 'dependency', 'template', 'store-only']
const ALL_PROVENANCES: readonly PluginProvenance[] = ['store', 'official', 'sub-bundle', 'local-link', 'external']
const ALL_SORTS: readonly SortKey[] = ['name', 'size', 'versions', 'usage']

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Keep only values present in `allowed`. */
function pick<T extends string>(values: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(values)) return []
  return values.filter((v): v is T => typeof v === 'string' && (allowed as readonly string[]).includes(v))
}

/** Parse one facet, accepting the legacy bare-array shape (pre-mode) as an
 * include-list so an existing filter is never silently lost. */
function parseFacet<T extends string>(raw: unknown, legacy: unknown, allowed: readonly T[]): Facet<T> {
  if (isRecord(raw)) {
    return {
      mode: raw.mode === 'exclude' ? 'exclude' : 'include',
      values: pick(raw.values, allowed),
    }
  }
  return { mode: 'include', values: pick(legacy, allowed) }
}

/** Parse a persisted config (or absence), falling back on any corruption. Pure. */
export function parseStoredFilters(raw: string | null): StoredFilters {
  if (raw === null) return DEFAULT_FILTERS
  try {
    const p = JSON.parse(raw) as Record<string, unknown>
    if (!isRecord(p)) return DEFAULT_FILTERS
    return {
      bucket: ALL_BUCKETS.includes(p.bucket as Bucket) ? p.bucket as Bucket : 'all',
      origin: parseFacet(p.origin, p.origins, ALL_ORIGINS),
      kind: parseFacet(p.kind, p.kinds, ALL_KINDS),
      provenance: parseFacet(p.provenance, p.provenances, ALL_PROVENANCES),
      sortKey: ALL_SORTS.includes(p.sortKey as SortKey) ? p.sortKey as SortKey : 'name',
      sortDir: p.sortDir === 'desc' ? 'desc' : 'asc',
    }
  } catch {
    return DEFAULT_FILTERS
  }
}

/** Read the persisted config from localStorage (defaults when unavailable). */
export function loadFilters(): StoredFilters {
  try {
    return parseStoredFilters(localStorage.getItem(FILTER_KEY))
  } catch {
    return DEFAULT_FILTERS
  }
}

/** Persist the current config (best-effort; a disabled storage is ignored). */
export function saveFilters(filters: StoredFilters): void {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filters))
  } catch {
    /* storage unavailable — the in-memory state still applies */
  }
}

/** Whether a facet admits a row's values. An empty facet admits everything;
 * otherwise `include` requires a hit and `exclude` requires none. */
export function facetMatches<T extends string>(facet: Facet<T>, values: readonly T[]): boolean {
  if (facet.values.length === 0) return true
  const hit = values.some(v => facet.values.includes(v))
  return facet.mode === 'include' ? hit : !hit
}

/** Inputs the overview filter needs beyond the persisted config. */
export interface OverviewFilterContext {
  /** Name substring filter (include only). */
  query: string
  /** Update-check results, for the `update` bucket. */
  updates: Map<string, PluginUpdateInfo>
  /** Registered dev-plugin names (hidden unless `showDev`). */
  devNames: Set<string>
  showDev: boolean
}

/** Apply the bucket, name, dev and facet filters to the overview rows. Pure. */
export function applyOverviewFilters(
  rows: readonly InstalledOverviewRow[],
  filters: StoredFilters,
  ctx: OverviewFilterContext,
): InstalledOverviewRow[] {
  const query = ctx.query.trim().toLowerCase()
  return rows.filter((row) => {
    // Dev plugins live in their own section; hidden here unless asked.
    if (!ctx.showDev && ctx.devNames.has(row.name)) return false
    if (query !== '' && !row.name.toLowerCase().includes(query)) return false
    switch (filters.bucket) {
      case 'used': if (row.usage.length === 0) return false; break
      case 'unused': if (!(row.inStore === true && row.usage.length === 0)) return false; break
      case 'update': if (ctx.updates.get(row.name)?.updateAvailable !== true) return false; break
      case 'template': if (row.kind !== 'template') return false; break
      default: break
    }
    if (!facetMatches(filters.origin, [row.origin ?? 'unknown'])) return false
    if (!facetMatches(filters.kind, [row.kind ?? 'dependency'])) return false
    if (!facetMatches(filters.provenance, row.provenances ?? [])) return false
    return true
  })
}
