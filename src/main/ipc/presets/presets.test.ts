/**
 * The preset IPC boundary: the listing a page renders, and the guard on every
 * write — an id that could escape the root, a metadata payload of the wrong
 * shape, and an unknown preset all refused before any filesystem work.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../core/settings/settings.ts'
import { updateDshState } from '../../core/profile/appState.ts'
import { setPresetTrash } from '../../core/presets/authoring.ts'
import { registerPresetsIpc } from './presets.ts'
import type { IpcResult, PresetListing } from '../../../shared/types.ts'

/** Every registered channel, plus the shell calls the write handlers make. */
const { channels, openPath, openExternal } = vi.hoisted(() => ({
  channels: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  openPath: vi.fn(async () => ''),
  openExternal: vi.fn(async () => undefined),
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  dialog: {},
  shell: { openPath, openExternal },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void => {
      channels.set(channel, fn)
    },
  },
}))

let root: string
let trashed: string[]
const home = (): string => join(root, 'home')
const userRoot = (): string => join(home(), '.agent-presets')

/** Invoke one registered handler. `handle` wraps every body in an async
 * function, so a handler call is always a promise. */
async function call<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  const fn = channels.get(channel)
  if (fn === undefined) throw new Error(`${channel} was not registered`)
  return await fn({}, ...args) as IpcResult<T>
}

/** Invoke one handler and unwrap its value, failing the test on a refusal. */
async function ok<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await call<T>(channel, ...args)
  if (!result.ok) throw new Error(`${channel} refused: ${result.code}`)
  return result.value
}

/** A preset directory whose composition names one built-in row, which resolves
 * with or without an install on this machine. */
function mkPreset(id: string): void {
  const dir = join(userRoot(), id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), '- id: persona\n  name: cordis:group\n')
}

/** A profile: a directory carrying a manifest, which is what dsh launches. */
function mkProfile(name: string): void {
  const dir = join(home(), 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dependencies: {} }))
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-preset-ipc-'))
  await openDatabase(join(root, 'app.sqlite'))
  mkdirSync(home(), { recursive: true })
  updateDshState(() => [{ id: 'a', name: 'dsh@a', execPath: '/fake/a', version: 'a', home: home() }])
  registerPresetsIpc()
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(userRoot(), { recursive: true, force: true })
  trashed = []
  setPresetTrash(async (target) => { trashed.push(target) })
  openPath.mockClear()
  openExternal.mockClear()
  mkPreset('mine')
  mkProfile('alpha')
  mkProfile('beta')
})

afterEach(() => { setPresetTrash(null) })

describe('preset:list', () => {
  it('returns the roots, roster, profiles and one grade per pairing', async () => {
    const listing = await ok<PresetListing>('preset:list', 'a')
    expect(listing.roots).toEqual([
      { path: userRoot(), trust: 'user', exists: true, writable: true },
    ])
    expect(listing.presets.map(row => [row.id, row.editable])).toEqual([['mine', true]])
    expect(listing.profiles).toEqual(['alpha', 'beta'])
    expect(listing.grades.map(cell => `${cell.presetId}/${cell.profile}:${cell.level}`)).toEqual([
      'mine/alpha:ok', 'mine/beta:ok',
    ])
  })

  it('refuses an unknown dsh', async () => {
    expect(await call('preset:list', 'nope')).toMatchObject({ ok: false, code: 'dsh.notFound' })
  })
})

describe('preset:saveMeta', () => {
  it('stores the three editable fields', async () => {
    expect(await ok<boolean>('preset:saveMeta', 'a', 'mine', {
      name: '我的模式', description: '一句话', order: 3,
    })).toBe(true)
    expect(readFileSync(join(userRoot(), 'mine', 'preset.yml'), 'utf8'))
      .toBe('name: 我的模式\ndescription: 一句话\norder: 3\n')
  })

  it('refuses an id that could escape the root', async () => {
    const result = await call('preset:saveMeta', 'a', '../escape', { name: 'x', description: '', order: null })
    expect(result).toMatchObject({ ok: false, code: 'preset.badId' })
    expect(existsSync(join(root, 'escape'))).toBe(false)
  })

  it('refuses a metadata payload of the wrong shape', async () => {
    const result = await call('preset:saveMeta', 'a', 'mine', { name: 1, description: '', order: null })
    expect(result).toMatchObject({ ok: false, code: 'name.invalid' })
  })

  it('refuses an unknown preset', async () => {
    const result = await call('preset:saveMeta', 'a', 'nope', { name: 'x', description: '', order: null })
    expect(result).toMatchObject({ ok: false, code: 'preset.notFound' })
  })
})

describe('preset:copy', () => {
  it('copies a preset into the writable root under a new id', async () => {
    expect(await ok<boolean>('preset:copy', 'a', 'mine', 'copy', '复制品')).toBe(true)
    expect(existsSync(join(userRoot(), 'copy', 'agent.cordis.yml'))).toBe(true)
    expect(readFileSync(join(userRoot(), 'copy', 'preset.yml'), 'utf8')).toBe('name: 复制品\n')
  })

  it('refuses an id another preset occupies', async () => {
    expect(await call('preset:copy', 'a', 'mine', 'mine', 'x'))
      .toMatchObject({ ok: false, code: 'preset.exists' })
  })
})

describe('preset:delete', () => {
  it('moves the preset directory to the recycle bin', async () => {
    expect(await ok<boolean>('preset:delete', 'a', 'mine')).toBe(true)
    expect(trashed).toEqual([join(userRoot(), 'mine')])
  })

  it('refuses an unknown preset', async () => {
    expect(await call('preset:delete', 'a', 'nope')).toMatchObject({ ok: false, code: 'preset.notFound' })
    expect(trashed).toEqual([])
  })
})

describe('preset:reveal and preset:openEditor', () => {
  it('reveals the directory in the OS file manager', async () => {
    expect(await ok<boolean>('preset:reveal', 'a', 'mine')).toBe(true)
    expect(openPath).toHaveBeenCalledWith(join(userRoot(), 'mine'))
  })

  it('opens the directory through the editor protocol', async () => {
    expect(await ok<boolean>('preset:openEditor', 'a', 'mine')).toBe(true)
    expect(openExternal).toHaveBeenCalledWith(
      `vscode://file/${join(userRoot(), 'mine').replace(/\\/g, '/')}`,
    )
  })

  it('refuses an unknown preset', async () => {
    expect(await call('preset:reveal', 'a', 'nope')).toMatchObject({ ok: false, code: 'preset.notFound' })
    expect(openPath).not.toHaveBeenCalled()
  })
})
