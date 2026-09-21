/**
 * The `ext:mcpSave` write guard.
 *
 * A row is INSERTED only when its id is free across the whole resolution: an id
 * that already resolves from another layer (a shipped bundle row, a home row)
 * is refused, because dsh merges rows by id — the insert would leave two rows
 * of the same id in play, and the launcher diagnoses the pair as a duplicate.
 * The target layer's own row is updated in place instead, which is the path the
 * edit form and the one-click sync both take.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../core/settings/settings.ts'
import { updateDshState } from '../../core/profile/appState.ts'
import { registerExtensionsIpc } from './extensions.ts'
import type { IpcResult, McpServerInput } from '../../../shared/types.ts'

/** Every registered channel, so a test can invoke one without ipcMain. */
const channels = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  dialog: {},
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void => {
      channels.set(channel, fn)
    },
  },
}))

let root: string
const home = (): string => join(root, 'home')
const profileDir = (name: string): string => join(home(), 'profiles', name)

/** A home-layer row, resolved by every profile. */
const HOME_ROW = [
  '- insert:',
  '    - id: mcp-github',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: github',
  '        transport: stdio',
  '        command: npx',
  '',
].join('\n')

const input = (over: Partial<McpServerInput> = {}): McpServerInput => ({
  id: '', serverName: 'github', transport: 'stdio', command: 'npx', ...over,
})

/** Invoke the registered handler. `handle` wraps every body in an async
 * function, so a handler call is always a promise. */
async function save(profile: string, value: McpServerInput, layer: 'profile' | 'home'): Promise<IpcResult<boolean>> {
  const fn = channels.get('ext:mcpSave')
  if (fn === undefined) throw new Error('ext:mcpSave was not registered')
  return await fn({}, 'a', profile, value, layer) as IpcResult<boolean>
}

function mkProfile(name: string): void {
  mkdirSync(profileDir(name), { recursive: true })
  writeFileSync(join(profileDir(name), 'package.json'), JSON.stringify({
    name,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }))
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-ext-ipc-'))
  await openDatabase(join(root, 'app.sqlite'))
  mkdirSync(home(), { recursive: true })
  updateDshState(() => [{ id: 'a', name: 'dsh@a', execPath: '/fake/a', version: 'a', home: home() }])
  registerExtensionsIpc()
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(join(home(), 'cordis.patch.yml'), { force: true })
  rmSync(join(home(), 'profiles'), { recursive: true, force: true })
  mkProfile('default')
})

describe('ext:mcpSave id guard', () => {
  it('refuses an insert whose id a home-layer row already resolves', async () => {
    writeFileSync(join(home(), 'cordis.patch.yml'), HOME_ROW)
    expect(await save('default', input({ id: 'mcp-github' }), 'profile'))
      .toMatchObject({ ok: false, code: 'ext.mcpIdTaken' })
  })

  it('refuses the derived id of a serverName a home-layer row already holds', async () => {
    writeFileSync(join(home(), 'cordis.patch.yml'), HOME_ROW)
    // No explicit id: `mcp-github` is derived from the serverName.
    expect(await save('default', input(), 'profile')).toMatchObject({ ok: false, code: 'ext.mcpIdTaken' })
  })

  it('updates the target layer’s own row instead of refusing it', async () => {
    expect((await save('default', input(), 'profile')).ok).toBe(true)
    expect((await save('default', input({ command: 'bunx' }), 'profile')).ok).toBe(true)
    expect(readFileSync(join(profileDir('default'), 'cordis.patch.yml'), 'utf8')).toContain('bunx')
  })

  it('still accepts a free id', async () => {
    writeFileSync(join(home(), 'cordis.patch.yml'), HOME_ROW)
    expect((await save('default', input({ serverName: 'other' }), 'profile')).ok).toBe(true)
  })

  it('a home write collides with a profile row holding the same id', async () => {
    expect((await save('default', input(), 'profile')).ok).toBe(true)
    expect(await save('default', input(), 'home')).toMatchObject({ ok: false, code: 'ext.mcpIdTaken' })
  })
})
