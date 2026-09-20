/**
 * Plugins-overview filter/sort config parsing (pure validation against the
 * allow-lists, so a stale / hand-edited localStorage value degrades to defaults)
 * plus the pure row predicate, including the include/exclude facet semantics.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILTERS, applyOverviewFilters, facetMatches, parseStoredFilters, type Facet, type StoredFilters,
} from './pluginFilters.ts'
import type { InstalledOverviewRow, PluginProvenance, PluginUpdateInfo } from '../../../shared/types.ts'

const row = (over: Partial<InstalledOverviewRow> & { name: string }): InstalledOverviewRow => ({
  versions: [], usage: [], inStore: false, sources: [], ...over,
})

const filters = (over: Partial<StoredFilters> = {}): StoredFilters => ({ ...DEFAULT_FILTERS, ...over })
const ctx = (over: Partial<Parameters<typeof applyOverviewFilters>[2]> = {}) => ({
  query: '', updates: new Map<string, PluginUpdateInfo>(), devNames: new Set<string>(), showDev: false, ...over,
})

describe('parseStoredFilters', () => {
  it('returns defaults for an absent value', () => {
    expect(parseStoredFilters(null)).toEqual(DEFAULT_FILTERS)
  })

  it('returns defaults for malformed JSON', () => {
    expect(parseStoredFilters('{not json')).toEqual(DEFAULT_FILTERS)
  })

  it('round-trips the current shape', () => {
    const cfg: StoredFilters = {
      bucket: 'unused',
      origin: { mode: 'include', values: ['npm'] },
      kind: { mode: 'exclude', values: ['template'] },
      provenance: { mode: 'exclude', values: ['official', 'sub-bundle'] },
      sortKey: 'size',
      sortDir: 'desc',
    }
    expect(parseStoredFilters(JSON.stringify(cfg))).toEqual(cfg)
  })

  it('migrates the legacy bare-array facets to include mode', () => {
    const parsed = parseStoredFilters(JSON.stringify({
      bucket: 'used', origins: ['npm'], kinds: ['bundle'], provenances: ['store'], sortKey: 'usage', sortDir: 'desc',
    }))
    expect(parsed.origin).toEqual({ mode: 'include', values: ['npm'] })
    expect(parsed.kind).toEqual({ mode: 'include', values: ['bundle'] })
    expect(parsed.provenance).toEqual({ mode: 'include', values: ['store'] })
    expect(parsed.bucket).toBe('used')
  })

  it('drops out-of-range values and unknown modes, keeping the valid ones', () => {
    const parsed = parseStoredFilters(JSON.stringify({
      bucket: 'bogus',
      origin: { mode: 'sideways', values: ['npm', 'bogus', 42] },
      kind: 'not-an-object',
      provenance: { mode: 'exclude', values: ['local-link'] },
      sortKey: 'nope',
      sortDir: 'sideways',
    }))
    expect(parsed.bucket).toBe('all')
    expect(parsed.origin).toEqual({ mode: 'include', values: ['npm'] })
    expect(parsed.kind).toEqual({ mode: 'include', values: [] })
    expect(parsed.provenance).toEqual({ mode: 'exclude', values: ['local-link'] })
    expect(parsed.sortKey).toBe('name')
    expect(parsed.sortDir).toBe('asc')
  })

  it('fills missing fields with defaults', () => {
    expect(parseStoredFilters(JSON.stringify({ bucket: 'used' }))).toEqual({ ...DEFAULT_FILTERS, bucket: 'used' })
  })
})

describe('facetMatches', () => {
  const facet = (mode: Facet<string>['mode'], values: string[]): Facet<string> => ({ mode, values })

  it('admits everything when empty', () => {
    expect(facetMatches(facet('include', []), ['template'])).toBe(true)
    expect(facetMatches(facet('exclude', []), ['template'])).toBe(true)
  })

  it('include keeps matches, exclude drops them', () => {
    expect(facetMatches(facet('include', ['bundle']), ['bundle'])).toBe(true)
    expect(facetMatches(facet('include', ['bundle']), ['template'])).toBe(false)
    expect(facetMatches(facet('exclude', ['template']), ['template'])).toBe(false)
    expect(facetMatches(facet('exclude', ['template']), ['bundle'])).toBe(true)
  })

  it('exclude keeps a row with no provenance values at all', () => {
    expect(facetMatches(facet('exclude', ['official']), [])).toBe(true)
  })
})

describe('applyOverviewFilters', () => {
  const rows = [
    row({ name: 'a', origin: 'npm', kind: 'bundle', provenances: ['store'], inStore: true, usage: [{ dsh: 'd', profile: 'p' }] }),
    row({ name: 'b', origin: 'npm', kind: 'template', provenances: ['official'] }),
    row({ name: 'c', origin: 'local', kind: 'dependency', provenances: ['store', 'official'], inStore: true, usage: [{ dsh: 'd', profile: 'q' }] }),
    row({ name: 'd', origin: 'github', kind: 'store-only', provenances: ['sub-bundle'], inStore: true }),
  ]
  const names = (list: InstalledOverviewRow[]): string[] => list.map(r => r.name)

  it('returns everything with no filters', () => {
    expect(names(applyOverviewFilters(rows, filters(), ctx()))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('applies include facets as a whitelist', () => {
    const f = filters({ origin: { mode: 'include', values: ['npm'] } })
    expect(names(applyOverviewFilters(rows, f, ctx()))).toEqual(['a', 'b'])
  })

  it('applies exclude facets as a blacklist', () => {
    const f = filters({ kind: { mode: 'exclude', values: ['template', 'dependency'] } })
    expect(names(applyOverviewFilters(rows, f, ctx()))).toEqual(['a', 'd'])
  })

  it('drops a row whose provenance set contains an excluded value', () => {
    const f = filters({ provenance: { mode: 'exclude', values: ['official'] } })
    expect(names(applyOverviewFilters(rows, f, ctx()))).toEqual(['a', 'd'])
  })

  it('ANDs across facets', () => {
    const f = filters({
      provenance: { mode: 'exclude', values: ['official'] },
      origin: { mode: 'include', values: ['npm', 'github'] },
    })
    expect(names(applyOverviewFilters(rows, f, ctx()))).toEqual(['a', 'd'])
  })

  it('hides dev plugins unless showDev, and still filters them when shown', () => {
    const devNames = new Set(['a'])
    expect(names(applyOverviewFilters(rows, filters(), ctx({ devNames })))).toEqual(['b', 'c', 'd'])
    expect(names(applyOverviewFilters(rows, filters(), ctx({ devNames, showDev: true })))).toEqual(['a', 'b', 'c', 'd'])
    const f = filters({ kind: { mode: 'exclude', values: ['template'] } })
    expect(names(applyOverviewFilters(rows, f, ctx({ devNames, showDev: true })))).toEqual(['a', 'c', 'd'])
  })

  it('applies the name query and the bucket', () => {
    expect(names(applyOverviewFilters(rows, filters(), ctx({ query: 'B' })))).toEqual(['b'])
    expect(names(applyOverviewFilters(rows, filters({ bucket: 'used' }), ctx()))).toEqual(['a', 'c'])
    expect(names(applyOverviewFilters(rows, filters({ bucket: 'unused' }), ctx()))).toEqual(['d'])
    expect(names(applyOverviewFilters(rows, filters({ bucket: 'template' }), ctx()))).toEqual(['b'])
  })

  it('filters the update bucket from the update map', () => {
    const updates = new Map<string, PluginUpdateInfo>([['d', {
      name: 'd', origin: 'npm', applied: [], archived: [], latest: '2.0.0', updateAvailable: true, manual: false,
    }]])
    expect(names(applyOverviewFilters(rows, filters({ bucket: 'update' }), ctx({ updates })))).toEqual(['d'])
  })
})
