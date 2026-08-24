/** Unit tests for the community-market core: pure install-target resolution +
 * catalog filtering/sorting. Following the project's pattern (see npm.test.ts),
 * the network couple (`loadMarket`) is exercised only through a stubbed fetch. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installSpecFor, loadMarket, queryCatalog } from './market.ts'
import type { MarketCatalog, MarketPlugin } from '../../shared/types.ts'

const mk = (over: Partial<MarketPlugin> = {}): MarketPlugin => ({
  name: 'demo',
  owner: 'o',
  url: 'https://github.com/o/demo',
  category: 'ui',
  description: { en: 'Demo' },
  install: 'dsh plugin add demo',
  ...over,
})

const cat = (plugins: MarketPlugin[]): MarketCatalog => ({
  updated: '2026-01-01',
  count: plugins.length,
  categories: { ui: { en: 'UI', zh: 'UI 增强' }, model: { en: 'Models', zh: '模型' } },
  plugins,
})

afterEach(() => vi.unstubAllGlobals())

// ── installSpecFor ───────────────────────────────────────────────────────────

describe('installSpecFor', () => {
  it('prefers a verified npm name', () => {
    expect(installSpecFor(mk({ npm: '@scope/pkg' }))).toBe('@scope/pkg')
  })

  it('falls back to a github: spec for a repo URL', () => {
    expect(installSpecFor(mk({ npm: null }))).toBe('github:o/demo')
  })

  it('maps a /tree/ subpath to a #path: selector', () => {
    expect(installSpecFor(mk({ url: 'https://github.com/a/b/tree/main/plugins/x', npm: null }))).toBe('github:a/b#path:/plugins/x')
  })

  it('ignores a malformed npm name and still resolves the repo', () => {
    expect(installSpecFor(mk({ npm: '../../evil' }))).toBe('github:o/demo')
  })

  it('returns null for a non-GitHub, non-npm entry', () => {
    expect(installSpecFor(mk({ url: 'https://example.com/x', npm: null }))).toBeNull()
    expect(installSpecFor(mk({ url: '', npm: null }))).toBeNull()
  })

  it('rejects path traversal in a subpath', () => {
    expect(installSpecFor(mk({ url: 'https://github.com/a/b/tree/main/../..', npm: null }))).toBeNull()
  })
})

// ── queryCatalog ────────────────────────────────────────────────────────────

describe('queryCatalog', () => {
  const c = cat([
    mk({ name: 'alpha', category: 'ui', stars: 100 }),
    mk({ name: 'beta', category: 'model', stars: null, npm: '@o/beta' }),
    mk({ name: 'gamma', category: 'ui', stars: null, downloads: 5000, description: { en: 'fun', zh: '有趣' } }),
  ])

  it('filters by category', () => {
    expect(queryCatalog(c, { category: 'model' }).map(p => p.name)).toEqual(['beta'])
  })

  it('matches free text across name / owner / npm / descriptions (incl. zh)', () => {
    expect(queryCatalog(c, { q: 'gamma' }).map(p => p.name)).toEqual(['gamma'])
    expect(queryCatalog(c, { q: '@o/beta' }).map(p => p.name)).toEqual(['beta'])
    expect(queryCatalog(c, { q: '有趣' }).map(p => p.name)).toEqual(['gamma'])
  })

  it('sorts by stars, putting unknown (null) stars last', () => {
    expect(queryCatalog(c, { sort: 'stars' }).map(p => p.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('sorts by downloads, putting unknown downloads last', () => {
    const rows = queryCatalog(c, { sort: 'downloads' })
    expect(rows[0].name).toBe('gamma') // the only one that has downloads
  })

  it('sorts newest by added date, unknown dates last', () => {
    const c2 = cat([
      mk({ name: 'old', added: '2025-01-01' }),
      mk({ name: 'new', added: '2026-06-01' }),
      mk({ name: 'noDate' }),
    ])
    expect(queryCatalog(c2, { sort: 'newest' }).map(p => p.name)).toEqual(['new', 'old', 'noDate'])
  })

  it('returns an empty list when nothing matches', () => {
    expect(queryCatalog(c, { q: 'zzz' })).toEqual([])
  })
})

// ── loadMarket (single origin, via stubbed fetch) ───────────────────────────

/** Minimal stand-in for a fetch Response. Real `Response` can't be built with
 * status 304, so tests construct a plain object implementing just the surface
 * `loadMarket` touches (`status`/`ok`/`json`/`headers.get`). */
function fakeRes(status: number, body = '', etag: string | null = null): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => JSON.parse(body),
    headers: { get: (name: string) => (name === 'etag' ? etag : null) },
  } as unknown as Response
}

describe('loadMarket', () => {
  const body = JSON.stringify({ updated: '2026-01-01', count: 1, categories: {}, plugins: [mk()] })

  it('parses a successful catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(200, body, '"v1"')))
    const catalog = await loadMarket({ source: 'official', url: '' })
    expect(catalog.plugins.length).toBe(1)
    expect(catalog.plugins[0].name).toBe('demo')
  })

  it('reuses the memo on 304 without re-parsing', async () => {
    const fn = vi.fn(async (url: string, init: RequestInit) => {
      // First real fetch → 200; any later call gets a 304 when the validator matches.
      const ifNoneMatch = (init.headers as Record<string, string> | undefined)?.['if-none-match']
      return ifNoneMatch === '"v1"' ? fakeRes(304) : fakeRes(200, body, '"v1"')
    })
    vi.stubGlobal('fetch', fn)
    await loadMarket({ source: 'official', url: '' })
    const second = await loadMarket({ source: 'official', url: '' })
    expect(second.plugins.length).toBe(1)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('throws (never serves stale) when the origin is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(500)))
    await expect(loadMarket({ source: 'official', url: '' })).rejects.toThrow()
  })
})