/**
 * Plugins-overview filter/sort config parsing: pure validation against the
 * allow-lists, so a stale / hand-edited localStorage value degrades to defaults.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_FILTERS, parseStoredFilters } from './pluginFilters.ts'

describe('parseStoredFilters', () => {
  it('returns defaults for an absent value', () => {
    expect(parseStoredFilters(null)).toEqual(DEFAULT_FILTERS)
  })

  it('returns defaults for malformed JSON', () => {
    expect(parseStoredFilters('{not json')).toEqual(DEFAULT_FILTERS)
  })

  it('round-trips a valid config', () => {
    const cfg = {
      bucket: 'unused', origins: ['npm'], kinds: ['bundle', 'dependency'],
      provenances: ['store', 'official'], sortKey: 'size', sortDir: 'desc',
    }
    expect(parseStoredFilters(JSON.stringify(cfg))).toEqual(cfg)
  })

  it('drops out-of-range values but keeps the valid ones', () => {
    const parsed = parseStoredFilters(JSON.stringify({
      bucket: 'bogus',
      origins: ['npm', 'bogus', 42],
      kinds: 'not-an-array',
      provenances: ['local-link'],
      sortKey: 'nope',
      sortDir: 'sideways',
    }))
    expect(parsed.bucket).toBe('all')
    expect(parsed.origins).toEqual(['npm'])
    expect(parsed.kinds).toEqual([])
    expect(parsed.provenances).toEqual(['local-link'])
    expect(parsed.sortKey).toBe('name')
    expect(parsed.sortDir).toBe('asc')
  })

  it('fills missing fields with defaults', () => {
    expect(parseStoredFilters(JSON.stringify({ bucket: 'used' }))).toEqual({
      ...DEFAULT_FILTERS, bucket: 'used',
    })
  })
})
