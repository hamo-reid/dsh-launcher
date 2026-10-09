/**
 * The plugin update check's cache.
 *
 * Its key has to cover everything the answer depends on. What "latest" means comes
 * from a HOST, so the registry is one of those inputs: a result computed against
 * a private mirror must not be served after the user points the launcher at a
 * different one. The window is small (the TTL) but the answer is wrong for all of
 * it, and it is wrong in the direction that looks like a fact ("no updates").
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, patchSettings } from '../settings/settings.ts'
import { checkPluginUpdates } from './updates.ts'

let root: string
const store = (): string => join(root, 'store')

/** One archived plugin, so the overview has an npm-origin row to check. */
function seedArchived(name: string, version: string): void {
  const dir = join(store(), 'archive', name, version, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
}

/** Answer every packument request with the `latest` that host advertises. */
function stubRegistries(byHost: Record<string, string>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const host = new URL(url).host
    const latest = byHost[host]
    if (latest === undefined) return { ok: false, status: 404, json: async () => ({}) }
    return {
      ok: true,
      status: 200,
      json: async () => ({ 'dist-tags': { latest }, versions: { [latest]: {} } }),
    }
  }))
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-updates-'))
  await openDatabase(join(root, 'app.sqlite'))
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => vi.unstubAllGlobals())

describe('checkPluginUpdates cache', () => {
  it('recomputes after the registry changes instead of serving the old host\'s verdict', async () => {
    seedArchived('demo', '1.0.0')
    stubRegistries({ 'mirror-a.example': '1.1.0', 'mirror-b.example': '1.0.0' })

    patchSettings({ registryUrl: 'https://mirror-a.example' })
    const first = await checkPluginUpdates([], store())
    expect(first[0]).toMatchObject({ name: 'demo', latest: '1.1.0', updateAvailable: true })

    // Same store, same versions — only the registry moved. A cached answer here
    // would report mirror A's "1.1.0 is available" against mirror B.
    patchSettings({ registryUrl: 'https://mirror-b.example' })
    const second = await checkPluginUpdates([], store())
    expect(second[0]).toMatchObject({ latest: '1.0.0', updateAvailable: false })
  })

  it('still serves the cache for an unchanged registry', async () => {
    // The fix must not turn the cache off: an identical signature is exactly what
    // it is for, and the network check is the expensive part.
    seedArchived('cached', '1.0.0')
    patchSettings({ registryUrl: 'https://mirror-a.example' })
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '1.2.0' }, versions: { '1.2.0': {} } }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await checkPluginUpdates([], store())
    const calls = fetchMock.mock.calls.length
    const second = await checkPluginUpdates([], store())
    expect(second).toEqual(first)
    expect(fetchMock.mock.calls.length).toBe(calls)
  })
})
