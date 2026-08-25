/**
 * Download-session manager: parallel cancellable sessions that own an
 * AbortController feeding `installSource`, plus a leftover-cleanup pass over the
 * store (`.staging` + `.import`). `installSource` is stubbed (real FS cleanup is
 * exercised against a disposable store tree).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSource } from './plugins.ts'
import { cancelPluginDownload, cleanupPluginDownloads, listPluginDownloads, startDshDownload, startPluginDownload } from './pluginDownloads.ts'

vi.mock('./plugins.ts', async (importActual) => {
  const actual = await importActual<typeof import('./plugins.ts')>()
  return { ...actual, installSource: vi.fn() }
})

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pm-dl-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))
const store = (): string => join(root, 'store')

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

describe('pluginDownloads', () => {
  it('tracks a running session by source, then removes it once done', async () => {
    vi.mocked(installSource).mockResolvedValueOnce({ ok: true, text: 'added' })
    const id = startPluginDownload(store(), 'pkg@1.0.0')
    const run = listPluginDownloads().find(d => d.id === id)!
    expect(run.status).toBe('running')
    expect(run.name).toBe('pkg')
    await settle()
    // a settled session is removed server-side (panel shows live work only)
    expect(listPluginDownloads().find(d => d.id === id)).toBeUndefined()
  })

  it('cancel makes a running session settle; unknown ids are a no-op', async () => {
    vi.mocked(installSource).mockImplementation((_s, _n, _src, signal) =>
      new Promise(resolve => {
        signal?.addEventListener('abort', () => resolve({ ok: false, aborted: true, text: 'cancelled' }))
      }))
    const id = startPluginDownload(store(), 'github:owner/pkg')
    expect(cancelPluginDownload(id)).toBe(true)
    expect(cancelPluginDownload('nope')).toBe(false)
    await settle()
    expect(listPluginDownloads().find(d => d.id === id)).toBeUndefined()
  })

  it('cleanup removes .staging and .import leftovers', () => {
    const staging = join(join(store(), 'archive'), 'pkg', '.staging')
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'package.json'), '{}')
    const imp = join(store(), '.import')
    mkdirSync(imp, { recursive: true })
    writeFileSync(join(imp, 'x.txt'), 'x')

    const { removed } = cleanupPluginDownloads(store())
    expect(removed.length).toBe(2)
    expect(existsSync(staging)).toBe(false)
    expect(existsSync(imp)).toBe(false)
  })

  it('tracks a dsh session with live steps, then removes it once done', async () => {
    const id = startDshDownload('official', '官方安装', async patchStep => {
      patchStep({ key: 'version', status: 'ok', meta: '1.0.0' })
      patchStep({ key: 'install', status: 'running' })
    })
    const run = listPluginDownloads().find(d => d.id === id)!
    expect(run.kind).toBe('dsh')
    expect(run.detail).toBe('官方安装')
    expect(run.steps).toEqual([
      { key: 'version', status: 'ok', meta: '1.0.0' },
      { key: 'install', status: 'running' },
    ])
    await settle()
    // a settled dsh session is likewise removed server-side
    expect(listPluginDownloads().find(d => d.id === id)).toBeUndefined()
  })

  it('surfaces a failing dsh job as a failed (removed) session', async () => {
    const id = startDshDownload('official', '', async () => { throw new Error('boom') })
    await settle()
    expect(listPluginDownloads().find(d => d.id === id)).toBeUndefined()
  })
})