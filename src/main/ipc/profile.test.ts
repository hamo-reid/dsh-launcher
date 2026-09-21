/**
 * `profile:addRow`'s YAML validation.
 *
 * The config body of an MCP row that holds a secret carries a cordis `!!js`
 * reference — that is what the launcher itself renders (`core/mcp.ts`). The
 * validator cannot resolve that tag, so it must skip the deep check rather than
 * report the row as malformed YAML and refuse to save it. A genuinely malformed
 * body is still refused.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../core/settings.ts'
import { updateDshState } from '../core/appState.ts'
import { registerProfileIpc } from './profile.ts'
import type { IpcResult, RowCreateInput } from '../../shared/types.ts'

/** Every registered channel, so a test can invoke one without ipcMain. */
const channels = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  dialog: {},
  shell: {},
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void => {
      channels.set(channel, fn)
    },
  },
}))

let root: string
const home = (): string => join(root, 'home')
const profileDir = (name: string): string => join(home(), 'profiles', name)
const patchPath = (name: string): string => join(profileDir(name), 'cordis.patch.yml')

/** The config an MCP server with a secret reference is saved with. */
const SECRET_CONFIG = [
  'command: bunx',
  'args:',
  '  - -y',
  '  - server-github',
  'env:',
  '  GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN',
].join('\n')

async function addRow(name: string, row: RowCreateInput): Promise<IpcResult<boolean>> {
  const fn = channels.get('profile:addRow')
  if (fn === undefined) throw new Error('profile:addRow was not registered')
  return await fn({}, 'a', name, row) as IpcResult<boolean>
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-profile-ipc-'))
  await openDatabase(join(root, 'app.sqlite'))
  mkdirSync(home(), { recursive: true })
  updateDshState(() => [{ id: 'a', name: 'dsh@a', execPath: '/fake/a', version: 'a', home: home() }])
  registerProfileIpc()
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('profile:addRow config validation', () => {
  it('accepts a config body carrying a !!js secret reference', async () => {
    mkdirSync(profileDir('secret'), { recursive: true })
    expect(await addRow('secret', { id: 'mcp-github', config: SECRET_CONFIG }))
      .toMatchObject({ ok: true, value: true })
    // The reference reaches disk intact — it is not quoted or re-encoded.
    expect(readFileSync(patchPath('secret'), 'utf8')).toContain('GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN')
  })

  it('still refuses a malformed config body', async () => {
    mkdirSync(profileDir('broken'), { recursive: true })
    expect(await addRow('broken', { id: 'mcp-bad', config: 'a: [1,2' }))
      .toMatchObject({ ok: false, code: 'internal' })
  })

  it('still refuses a config body that is not a mapping', async () => {
    mkdirSync(profileDir('scalar'), { recursive: true })
    expect(await addRow('scalar', { id: 'mcp-scalar', config: 'just-a-string\n' }))
      .toMatchObject({ ok: false, code: 'internal' })
  })
})
