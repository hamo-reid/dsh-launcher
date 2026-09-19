/**
 * Persisted overview filter/sort config for the Plugins page. Renderer-local UI
 * preference (localStorage), kept out of the main-process settings so it never
 * round-trips through IPC. Parsing is pure and unit-tested; every value is
 * validated against an allow-list so a stale / hand-edited store degrades to
 * defaults instead of throwing.
 */
import type { PluginKind, PluginOrigin, PluginProvenance } from '../../../shared/types.ts'

/** Overview bucket filters (classification). */
export type Bucket = 'all' | 'used' | 'unused' | 'update' | 'template'

/** Overview card sort orders. */
export type SortKey = 'name' | 'size' | 'versions' | 'usage'
export type SortDir = 'asc' | 'desc'

export interface StoredFilters {
  bucket: Bucket
  origins: PluginOrigin[]
  kinds: PluginKind[]
  provenances: PluginProvenance[]
  sortKey: SortKey
  sortDir: SortDir
}

export const FILTER_KEY = 'pm.plugins.overview.filters'

export const DEFAULT_FILTERS: StoredFilters = {
  bucket: 'all', origins: [], kinds: [], provenances: [], sortKey: 'name', sortDir: 'asc',
}

const ALL_BUCKETS: readonly Bucket[] = ['all', 'used', 'unused', 'update', 'template']
const ALL_ORIGINS: readonly PluginOrigin[] = ['npm', 'github', 'local', 'unknown']
const ALL_KINDS: readonly PluginKind[] = ['bundle', 'dependency', 'template', 'store-only']
const ALL_PROVENANCES: readonly PluginProvenance[] = ['store', 'official', 'sub-bundle', 'local-link', 'external']
const ALL_SORTS: readonly SortKey[] = ['name', 'size', 'versions', 'usage']

/** Keep only values present in `allowed`. */
function pick<T extends string>(values: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(values)) return []
  return values.filter((v): v is T => typeof v === 'string' && (allowed as readonly string[]).includes(v))
}

/** Parse a persisted config (or absence), falling back on any corruption. Pure. */
export function parseStoredFilters(raw: string | null): StoredFilters {
  if (raw === null) return DEFAULT_FILTERS
  try {
    const p = JSON.parse(raw) as Partial<StoredFilters>
    return {
      bucket: ALL_BUCKETS.includes(p.bucket as Bucket) ? p.bucket as Bucket : 'all',
      origins: pick(p.origins, ALL_ORIGINS),
      kinds: pick(p.kinds, ALL_KINDS),
      provenances: pick(p.provenances, ALL_PROVENANCES),
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
