/**
 * What a snapshot is judged against.
 *
 * `preSnapshotChecks` resolves the patch rows the archive will be loaded with:
 * an id-only row (a config override) is meaningless without the layer that
 * inserted it, and a row naming a package the monorepo only reaches through the
 * profile is missing outside it. Both live in the PROFILE, so a snapshot that
 * knows its target profile must judge against it — the failure this file pins
 * down is a bundle that works in the profile being reported as un-snapshottable
 * because the handler never passed the profile down.
 *
 * `snapshotDevPlugin` is stubbed: what matters here is the options it is handed,
 * not what pnpm then does with them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../core/settings/settings.ts'
import { updateDshState } from '../../core/profile/appState.ts'
import { registerDevPlugin } from '../../core/store/dev.ts'
import { registerPluginsIpc } from './plugins.ts'
import type { DevLinkMode, IpcResult } from '../../../shared/types.ts'

/** Every registered channel, so a test can invoke one without ipcMain. */
const channels = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())

/** One entry per `snapshotDevPlugin` call: the options it was handed. */
const shots = vi.hoisted(() => [] as { name: string; profile?: string; targets: { profile: string }[] }[])

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

vi.mock('../../core/store/dev.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../core/store/dev.ts')>()
  return {
    ...actual,
    snapshotDevPlugin: async (dev: { name: string; dir: string }, _ctx: unknown, opts: {
      profile?: string
      targets?: readonly { profile: string }[]
    }) => {
      shots.push({
        name: dev.name,
        ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
        targets: [...(opts.targets ?? [])],
      })
      return { ok: true, text: 'archived', command: '', cwd: dev.dir }
    },
  }
})

let root: string
let execPath: string

async function call(channel: string, ...args: unknown[]): Promise<IpcResult<unknown>> {
  const fn = channels.get(channel)
  if (fn === undefined) throw new Error(`${channel} was not registered`)
  return await fn({}, ...args) as IpcResult<unknown>
}

const snapshot = (name: string, targets?: { dshId: string; profile: string }[]) => call('plugins:devSnapshot', name, targets)
const link = (dshId: string, profile: string, name: string, mode: DevLinkMode) => call('plugins:devLinkToProfile', dshId, profile, name, mode)

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-devshot-ipc-'))
  await openDatabase(join(root, 'app.sqlite'))
  mkdirSync(join(root, 'store'), { recursive: true })
  // A configured store: `pluginDir()` must not fall back to the electron
  // `userData`, which this test does not have.
  const { patchSettings } = await import('../../core/settings/settings.ts')
  patchSettings({ pluginDir: join(root, 'store') })

  const install = join(root, 'install', 'node_modules', '.bin')
  mkdirSync(install, { recursive: true })
  writeFileSync(join(root, 'install', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' }))
  execPath = join(install, 'dsh.cmd')
  writeFileSync(execPath, '')
  updateDshState(() => [
    { id: execPath, name: 'dsh@1.0.0', execPath, version: '1.0.0', home: join(root, 'home') },
  ])

  const pkgDir = join(root, 'repo', 'packages', 'foo')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: '@me/dsh-foo', version: '0.1.0', exports: { '.': './dist/index.js' }, dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), '- id: tools\n  config:\n    mode: native\n')
  registerDevPlugin(pkgDir)
  registerPluginsIpc()
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => { shots.length = 0 })

describe('a snapshot is judged against the profile it will be installed into', () => {
  it('devLinkToProfile(copy) hands the check the target profile', async () => {
    const result = await link(execPath, 'work', '@me/dsh-foo', 'copy')
    expect(result.ok).toBe(true)
    expect(shots).toHaveLength(1)
    expect(shots[0]).toMatchObject({ profile: 'work' })
    expect(shots[0].targets).toEqual([expect.objectContaining({ profile: 'work' })])
  })

  it('devSnapshot hands the check its first target profile', async () => {
    const result = await snapshot('@me/dsh-foo', [{ dshId: execPath, profile: 'work' }])
    expect(result.ok).toBe(true)
    expect(shots[0]).toMatchObject({ profile: 'work' })
  })

  it('several targets are judged against the first, which is the one archived into', async () => {
    const result = await snapshot('@me/dsh-foo', [
      { dshId: execPath, profile: 'work' },
      { dshId: execPath, profile: 'staging' },
    ])
    expect(result.ok).toBe(true)
    expect(shots[0].profile).toBe('work')
    expect(shots[0].targets.map(t => t.profile)).toEqual(['work', 'staging'])
  })

  it('a bare snapshot stays profile-less rather than inventing one', async () => {
    const result = await snapshot('@me/dsh-foo')
    expect(result.ok).toBe(true)
    expect(shots[0].profile).toBeUndefined()
    expect(shots[0].targets).toEqual([])
  })
})
