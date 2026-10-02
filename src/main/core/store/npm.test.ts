/**
 * Tests for the npm registry normalization (pure logic; the fetch is exercised
 * via the IPC layer at runtime, so here we feed canned raw payloads), plus the
 * base URL both HTTP calls build on — which is the point of the registry setting.
 */
import { afterAll, beforeAll, describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, patchSettings } from '../settings/settings.ts'
import { fetchPackageVersions, normalizeSearchResults, npmSearch, type RawSearchPackage } from './npm.ts'

let root: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-registry-'))
  await openDatabase(join(root, 'app.sqlite'))
  patchSettings({ registryUrl: 'https://registry.internal.example' })
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('normalizeSearchResults', () => {
  it('maps name/description/version and reads total', () => {
    const data = {
      total: 3,
      objects: [
        { package: { name: 'a', description: 'desc a', version: '1.0.0' } },
        { package: { name: 'b', description: 'desc b', version: '2.0.0' } },
      ],
    }
    const { hits, total } = normalizeSearchResults(data)
    expect(total).toBe(3)
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ name: 'a', description: 'desc a', version: '1.0.0' })
  })

  it('falls back to hits length when total is absent', () => {
    const { total } = normalizeSearchResults({ objects: [{ package: { name: 'a' } }] })
    expect(total).toBe(1)
  })

  it('maps author from a string and from an object', () => {
    const a = normalizeSearchResults({ objects: [{ package: { name: 'x', author: 'Ann' } }] })
    expect(a.hits[0].author).toBe('Ann')
    const b = normalizeSearchResults({ objects: [{ package: { name: 'x', author: { name: 'Bob' } } }] })
    expect(b.hits[0].author).toBe('Bob')
    const c = normalizeSearchResults({ objects: [{ package: { name: 'x' } }] })
    expect(c.hits[0].author).toBeUndefined()
  })

  it('carries date and keywords only when present', () => {
    const { hits } = normalizeSearchResults({
      objects: [{
        package: {
          name: 'y', date: '2026-01-02T00:00:00.000Z', keywords: ['dsh', 'plugin'],
        } as RawSearchPackage,
      }],
    })
    expect(hits[0].date).toBe('2026-01-02T00:00:00.000Z')
    expect(hits[0].keywords).toEqual(['dsh', 'plugin'])
    expect(hits[0].author).toBeUndefined()
  })

  it('drops entries without a name', () => {
    const { hits } = normalizeSearchResults({ objects: [{ package: {} }, { package: { name: 'z' } }] })
    expect(hits).toHaveLength(1)
    expect(hits[0].name).toBe('z')
  })
})

/** Mock `fetch` (the registry calls) so the HTTP layer stays out of tests. */
function stubFetch(resp: () => { status: number; body: unknown }): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: resp().status < 400,
    status: resp().status,
    json: async () => resp().body,
  })))
}

describe('fetchPackageVersions', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads dist-tags and versions', async () => {
    stubFetch(() => ({ status: 200, body: { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {}, '1.1.0': {} } } }))
    const info = await fetchPackageVersions('@deepseek-ai/dsh')
    expect(info.distTags).toEqual({ latest: '1.0.0' })
    expect(info.versions).toEqual(['1.0.0', '1.1.0'])
  })

  it('handles a package with no versions', async () => {
    stubFetch(() => ({ status: 200, body: {} }))
    const info = await fetchPackageVersions('empty')
    expect(info).toEqual({ distTags: {}, versions: [] })
  })

  it('throws on a non-OK registry response', async () => {
    stubFetch(() => ({ status: 404, body: {} }))
    await expect(fetchPackageVersions('nope')).rejects.toThrow(/HTTP 404/)
  })
})

describe('npmSearch', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks the CONFIGURED registry, not the public one', async () => {
    // The invariant this module exists for: choosing a version and installing it
    // must resolve against the same registry. Both URLs were hardcoded before.
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(url)
      return { ok: true, status: 200, json: async () => ({}) }
    }))
    await fetchPackageVersions('@deepseek-ai/dsh')
    await npmSearch('dsh')
    expect(seen[0]).toBe(`https://registry.internal.example/${encodeURIComponent('@deepseek-ai/dsh')}`)
    expect(seen[1]).toContain('https://registry.internal.example/-/v1/search')
  })

  it('falls back to the public registry with no configured one', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(url)
      return { ok: true, status: 200, json: async () => ({}) }
    }))
    // Cleared first: this file configures a private registry for the test above,
    // and both cases must be exercised against the same code path.
    await patchSettings({ registryUrl: undefined })
    await fetchPackageVersions('pkg')
    expect(seen[0]).toBe('https://registry.npmjs.org/pkg')
    await patchSettings({ registryUrl: 'https://registry.internal.example' })
  })

  it('maps a search response and defers to the registry total', async () => {
    stubFetch(() => ({
      status: 200,
      body: { total: 42, objects: [{ package: { name: 'pkg-a', description: 'd' } }] },
    }))
    const { hits, total } = await npmSearch('dsh')
    expect(total).toBe(42)
    expect(hits).toHaveLength(1)
    expect(hits[0].name).toBe('pkg-a')
  })

  it('throws on a non-OK search response', async () => {
    stubFetch(() => ({ status: 500, body: {} }))
    await expect(npmSearch('dsh')).rejects.toThrow(/HTTP 500/)
  })
})