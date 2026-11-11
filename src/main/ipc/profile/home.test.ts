/**
 * Writes to the machine-level patch layer.
 *
 * `<home>/cordis.patch.yml` is composed into every profile under the home, and
 * every running process watches it with no bundle-list gate — one save can
 * recompose a profile the person was not looking at. These tests lock the two
 * halves of the answer: the refusal names the live profiles and writes nothing,
 * and the acknowledgement lets the write through.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const channels = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())
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

import { openDatabase } from '../../core/settings/settings.ts'
import { configureAppState, updateDshState } from '../../core/profile/appState.ts'
import { registerHomeIpc } from './home.ts'
import type { IpcResult, LayerWrite, PluginWritePending } from '../../../shared/types.ts'

const DSH_ID = 'd1'
let root: string

const home = (): string => join(root, 'home')
const homePatch = (): string => join(home(), 'cordis.patch.yml')
const profile = (name: string): string => join(home(), 'profiles', name)

async function invoke(channel: string, ...args: unknown[]): Promise<IpcResult<unknown>> {
  const fn = channels.get(channel)
  if (fn === undefined) throw new Error(`${channel} was not registered`)
  return await fn({}, ...args) as IpcResult<unknown>
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-home-ipc-'))
  await openDatabase(join(root, 'app.sqlite'))
  configureAppState(join(root, 'appdata'))
  const bin = join(root, 'install', 'node_modules', '.bin', 'dsh.cmd')
  mkdirSync(join(root, 'install', 'node_modules', '.bin'), { recursive: true })
  writeFileSync(bin, '')
  writeFileSync(join(root, 'install', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' }))
  updateDshState(() => [{ id: DSH_ID, name: 'dsh@1.0.0', execPath: bin, version: '1.0.0', home: home() }])
  registerHomeIpc()
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

beforeEach(() => {
  running.clear()
  rmSync(home(), { recursive: true, force: true })
  mkdirSync(profile('web'), { recursive: true })
  writeFileSync(join(profile('web'), 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies: {}, dsh: { profile: { bundles: [] } } }))
})

describe('home:writePatch', () => {
  it('refuses while a profile runs and leaves the file alone', async () => {
    running.add(`${DSH_ID}\u0000web`)
    const res = await invoke('home:writePatch', DSH_ID, '- id: a\n')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const value = res.value as LayerWrite & PluginWritePending
    expect(value.needsConfirm).toBe('profiles-running')
    expect(value.written).toBe(false)
    expect(value.profiles).toEqual([{ dsh: 'dsh@1.0.0', dshId: DSH_ID, profile: 'web' }])
    expect(existsSync(homePatch())).toBe(false)
  })

  it('writes once the caller acknowledges', async () => {
    running.add(`${DSH_ID}\u0000web`)
    const res = await invoke('home:writePatch', DSH_ID, '- id: a\n', { acknowledgeRunning: true })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect((res.value as LayerWrite).written).toBe(true)
    expect(readFileSync(homePatch(), 'utf8')).toBe('- id: a\n')
  })

  it('asks nothing when no profile is running', async () => {
    const res = await invoke('home:writePatch', DSH_ID, '- id: a\n')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect((res.value as LayerWrite).written).toBe(true)
  })
})

describe('home:setDisabled', () => {
  it('refuses while a profile runs and creates no file', async () => {
    running.add(`${DSH_ID}\u0000web`)
    const res = await invoke('home:setDisabled', DSH_ID, 'row-a', true)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const value = res.value as { disabled: boolean } & PluginWritePending
    expect(value.needsConfirm).toBe('profiles-running')
    expect(value.disabled).toBe(false)
    expect(existsSync(homePatch())).toBe(false)
  })
})
