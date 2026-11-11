/**
 * The store IPC's write guard: a plugin write that would touch a profile with a
 * live dsh process must stop and ask BEFORE it rewrites a manifest or deletes a
 * file. The refusal is a question, not an error — the payload names the profiles
 * and the retry carries the acknowledgement.
 *
 * These run against a real temporary tree with `runPnpm` stubbed, so what is
 * asserted is the file state after each answer: nothing written on a refusal,
 * dependency gone once the caller consents.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Every registered channel, so a test can invoke one without ipcMain. */
const channels = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())
/** The `(dshId, profile)` pairs that report a live run. */
const running = vi.hoisted(() => new Set<string>())

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  dialog: {},
  shell: {},
  BrowserWindow: { getFocusedWindow: () => null },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void => {
      channels.set(channel, fn)
    },
  },
}))

vi.mock('../dsh/run.ts', () => ({
  isProfileRunning: (dshId: string, profile: string): boolean => running.has(`${dshId}\u0000${profile}`),
}))

vi.mock('../../core/dsh/pnpm.ts', async (importActual) => {
  const actual = await importActual<typeof import('../../core/dsh/pnpm.ts')>()
  return { ...actual, runPnpm: vi.fn() }
})

import { runPnpm } from '../../core/dsh/pnpm.ts'
import { openDatabase } from '../../core/settings/settings.ts'
import { configureAppState, pluginDir, updateDshState } from '../../core/profile/appState.ts'
import { registerStoreIpc } from './store.ts'
import type { IpcResult, PluginUsagePoint, PluginWritePending } from '../../../shared/types.ts'

const DSH_ID = 'd1'
const PROFILE = 'p1'
const PKG = '@me/plugin'
const VERSION = '1.0.0'

let root: string

const home = (): string => join(root, 'home')
const profileDir = (): string => join(home(), 'profiles', PROFILE)
const manifestPath = (): string => join(profileDir(), 'package.json')
const archivePkg = (): string => join(pluginDir(), 'archive', PKG, VERSION, 'node_modules', PKG)

const manifest = (): { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } } =>
  JSON.parse(readFileSync(manifestPath(), 'utf8')) as ReturnType<typeof JSON.parse>

async function invoke(channel: string, ...args: unknown[]): Promise<IpcResult<Record<string, unknown>>> {
  const fn = channels.get(channel)
  if (fn === undefined) throw new Error(`${channel} was not registered`)
  return await fn({}, ...args) as IpcResult<Record<string, unknown>>
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-store-ipc-'))
  await openDatabase(join(root, 'app.sqlite'))
  configureAppState(join(root, 'appdata'))
  const bin = join(root, 'install', 'node_modules', '.bin', 'dsh.cmd')
  mkdirSync(join(root, 'install', 'node_modules', '.bin'), { recursive: true })
  writeFileSync(bin, '')
  writeFileSync(join(root, 'install', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' }))
  updateDshState(() => [{ id: DSH_ID, name: 'dsh@1.0.0', execPath: bin, version: '1.0.0', home: home() }])
  registerStoreIpc()
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

beforeEach(() => {
  running.clear()
  vi.mocked(runPnpm).mockReset()
  vi.mocked(runPnpm).mockResolvedValue({ ok: true, text: 'ok' })
  rmSync(join(root, 'home'), { recursive: true, force: true })
  rmSync(pluginDir(), { recursive: true, force: true })
  // One archived version, and one profile pointing at it from its bundle layer.
  mkdirSync(archivePkg(), { recursive: true })
  writeFileSync(join(archivePkg(), 'package.json'), JSON.stringify({ name: PKG, version: VERSION, dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  mkdirSync(profileDir(), { recursive: true })
  writeFileSync(manifestPath(), JSON.stringify({
    name: `dsh-profile-${PROFILE}`,
    dependencies: { [PKG]: `file:${archivePkg()}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', PKG] } },
  }, null, 2) + '\n')
})

describe('plugins:uninstall', () => {
  it('refuses while the profile runs and writes nothing', async () => {
    running.add(`${DSH_ID}\u0000${PROFILE}`)
    const before = readFileSync(manifestPath(), 'utf8')
    const res = await invoke('plugins:uninstall', PKG) as IpcResult<{ removed: PluginUsagePoint[] } & PluginWritePending>
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.needsConfirm).toBe('profiles-running')
    expect(res.value.profiles).toEqual([{ dsh: 'dsh@1.0.0', dshId: DSH_ID, profile: PROFILE }])
    expect(res.value.removed).toEqual([])
    expect(readFileSync(manifestPath(), 'utf8')).toBe(before)
    expect(vi.mocked(runPnpm)).not.toHaveBeenCalled()
  })

  it('detaches once the caller acknowledges', async () => {
    running.add(`${DSH_ID}\u0000${PROFILE}`)
    const res = await invoke('plugins:uninstall', PKG, { acknowledgeRunning: true }) as IpcResult<{ removed: PluginUsagePoint[] }>
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.removed).toHaveLength(1)
    expect(manifest().dependencies?.[PKG]).toBeUndefined()
    expect(manifest().dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })
})

describe('plugins:installToProfile', () => {
  it('refuses while the target profile runs', async () => {
    running.add(`${DSH_ID}\u0000${PROFILE}`)
    const res = await invoke('plugins:installToProfile', DSH_ID, PROFILE, PKG, VERSION) as IpcResult<PluginWritePending>
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.needsConfirm).toBe('profiles-running')
    expect(res.value.profiles?.[0]?.profile).toBe(PROFILE)
  })

  it('asks nothing when the profile is idle', async () => {
    const res = await invoke('plugins:installToProfile', DSH_ID, PROFILE, PKG, VERSION) as IpcResult<PluginWritePending & { text: string }>
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.needsConfirm).toBeUndefined()
  })
})

describe('plugins:detach', () => {
  it('refuses for the targeted usage while that profile runs', async () => {
    running.add(`${DSH_ID}\u0000${PROFILE}`)
    const res = await invoke('plugins:detach', PKG, [{ dsh: 'dsh@1.0.0', profile: PROFILE }]) as IpcResult<{ detached: PluginUsagePoint[] } & PluginWritePending>
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.needsConfirm).toBe('profiles-running')
    expect(res.value.detached).toEqual([])
    expect(manifest().dependencies?.[PKG]).toBeDefined()
  })
})

describe('plugins:remove', () => {
  it('refuses a whole-plugin removal while a referencing profile runs', async () => {
    running.add(`${DSH_ID}\u0000${PROFILE}`)
    const res = await invoke('plugins:remove', PKG) as IpcResult<{ detached: PluginUsagePoint[] } & PluginWritePending>
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.needsConfirm).toBe('profiles-running')
  })

  it('leaves the version-in-use refusal first when nothing will be detached', async () => {
    // No acknowledgement and no `detach`: this delete touches no profile, so the
    // existing "still referenced" refusal must stay the first thing reported.
    const res = await invoke('plugins:remove', PKG, VERSION)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('store.versionInUse')
  })
})
