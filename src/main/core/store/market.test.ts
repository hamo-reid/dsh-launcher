/** Unit tests for the community-market core: pure install-target resolution +
 * catalog filtering/sorting. Following the project's pattern (see npm.test.ts),
 * the network couple (`loadMarket`) is exercised only through a stubbed fetch. */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  forgetCatalog, installSpecFor, loadMarket, marketCatalogs, marketToken, pageCatalog, queryCatalog,
  resolveMarket, saveMarketCatalog, setMarketTokenCipher,
} from './market.ts'
import { openDatabase } from '../settings/settings.ts'
import type { SecretCipher } from '../settings/secret-at-rest.ts'
import type { MarketCatalog, MarketPlugin } from '../../../shared/types.ts'

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

// ── pageCatalog ──────────────────────────────────────────────────────────────

describe('pageCatalog', () => {
  const c = cat(Array.from({ length: 5 }, (_, i) => mk({ name: `p${i}`, stars: 100 - i })))

  it('slices a page and reports the total', () => {
    const page = pageCatalog(c, { page: 1, pageSize: 2 })
    expect(page.total).toBe(5)
    expect(page.items.map(p => p.name)).toEqual(['p0', 'p1'])
    expect(page.page).toBe(1)
    expect(page.pageSize).toBe(2)
  })

  it('advances the window per page', () => {
    const page = pageCatalog(c, { page: 3, pageSize: 2 })
    expect(page.items.map(p => p.name)).toEqual(['p4'])
  })

  it('clamps an out-of-range page into [1, lastPage]', () => {
    // past-the-end page clamps to the last page, not an empty slice
    expect(pageCatalog(c, { page: 99, pageSize: 2 }).page).toBe(3)
    // a degenerate page clamps up to 1
    expect(pageCatalog(c, { page: 0, pageSize: 2 }).page).toBe(1)
  })

  it('clamps pageSize into [1, MAX_PAGE_SIZE] and defaults to 20', () => {
    expect(pageCatalog(c).pageSize).toBe(20)
    expect(pageCatalog(c, { pageSize: 0 }).pageSize).toBe(1)
    expect(pageCatalog(c, { pageSize: -3 }).pageSize).toBe(1)
    expect(pageCatalog(c, { pageSize: 9999 }).pageSize).toBe(100)
  })

  it('applies the query before slicing', () => {
    const c2 = cat([
      mk({ name: 'alpha', category: 'ui', stars: 100 }),
      mk({ name: 'beta', category: 'model', stars: 99 }),
    ])
    const page = pageCatalog(c2, { category: 'model', page: 1, pageSize: 10 })
    expect(page.total).toBe(1)
    expect(page.items.map(p => p.name)).toEqual(['beta'])
  })

  it('passes categories through for the filter dropdown', () => {
    const page = pageCatalog(c, { pageSize: 1 })
    expect(page.categories).toHaveProperty('ui')
  })

  it('handles an empty match set with a single empty page', () => {
    const page = pageCatalog(cat([]), { page: 1, pageSize: 10 })
    expect(page.total).toBe(0)
    expect(page.items).toEqual([])
    expect(page.page).toBe(1)
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
    const fn = vi.fn(async (_url: string, init: RequestInit) => {
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

// ── saveMarketCatalog (probe + credential) ──────────────────────────────────

/** A cipher that is obviously reversible, so "the token was stored" is visible. */
const cipher: SecretCipher = {
  available: () => true,
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (stored) => (stored.startsWith('enc:') ? stored.slice(4) : ''),
}

describe('saveMarketCatalog', () => {
  const body = JSON.stringify({ plugins: [] })
  const dirs: string[] = []

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-market-'))
    dirs.push(dir)
    await openDatabase(join(dir, 'app.sqlite'))
    setMarketTokenCipher(cipher)
  })

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('authenticates the save probe with the token typed into the form', async () => {
    const headers: Record<string, string>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      headers.push((init.headers ?? {}) as Record<string, string>)
      return fakeRes(200, body)
    }))
    const result = await saveMarketCatalog({ name: 'CNB', url: 'https://api.cnb.cool/o/r/-/git/raw/main/plugins.json', token: 'tok-1' })
    expect(result).toEqual({ ok: true })
    expect(headers[0]?.authorization).toBe('Bearer tok-1')
    // The token lands in settings with the catalog, so the next refresh uses it.
    expect(marketToken()).toBe('tok-1')
  })

  it('reports a 401 as unauthorized instead of blaming the address', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(401)))
    const result = await saveMarketCatalog({ name: 'CNB', url: 'https://api.cnb.cool/o/r/-/git/raw/main/plugins.json' })
    expect(result).toEqual({ ok: false, reason: 'unauthorized', status: 401 })
  })

  it('reuses the stored token when an edit leaves the field empty', async () => {
    const headers: Record<string, string>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const sent = (init.headers ?? {}) as Record<string, string>
      headers.push(sent)
      return sent.authorization === undefined ? fakeRes(401) : fakeRes(200, body)
    }))
    const first = await saveMarketCatalog({ name: 'CNB', url: 'https://api.cnb.cool/o/r/-/git/raw/main/plugins.json', token: 'tok-2' })
    expect(first).toEqual({ ok: true })
    const saved = marketCatalogs().find((entry) => entry.url.endsWith('/plugins.json'))
    if (saved === undefined) throw new Error('the catalog was not saved')
    const second = await saveMarketCatalog({ id: saved.id, name: 'CNB (renamed)', url: saved.url })
    expect(second).toEqual({ ok: true })
    expect(headers[1]?.authorization).toBe('Bearer tok-2')
  })
})


describe('resolveMarket', () => {
  const body = JSON.stringify({ updated: '2026-01-01', count: 1, categories: {}, plugins: [mk()] })

  it('serves the memo after one network load — no second fetch', async () => {
    forgetCatalog()
    const fn = vi.fn(async () => fakeRes(200, body, '"v1"'))
    vi.stubGlobal('fetch', fn)
    const first = await resolveMarket({ source: 'official', url: '' })
    const second = await resolveMarket({ source: 'official', url: '' })
    expect(second).toBe(first) // same memo object, not a re-fetch
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('refresh forces a network revalidation', async () => {
    forgetCatalog()
    const fn = vi.fn(async () => fakeRes(200, body, '"v1"'))
    vi.stubGlobal('fetch', fn)
    await resolveMarket({ source: 'official', url: '' })
    await resolveMarket({ source: 'official', url: '' }, true)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})