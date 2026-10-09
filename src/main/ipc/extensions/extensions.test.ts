/**
 * The extensions IPC boundary, end to end over a disposable home.
 *
 * Two halves. `ext:mcpSave`'s write guard: a row is INSERTED only when its id is
 * free across the whole resolution — an id that already resolves from another
 * layer (a shipped bundle row, a home row) is refused, because dsh merges rows by
 * id, and the target layer's own row is updated in place instead.
 *
 * And the dsh-side skill channels (`ext:skill*`), which are what make creating a
 * skill in a dsh's writable root reachable from the page at all: scaffold → save →
 * read back, rename through the frontmatter, refuse to overwrite, import a zip.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { openDatabase, updateSettings } from '../../core/settings/settings.ts'
import { configureAppState, updateDshState } from '../../core/profile/appState.ts'
import { skillLibraryDir } from '../../core/skills/library.ts'
import { registerExtensionsIpc } from './extensions.ts'
import type { IpcResult, McpServerInput, SkillEntry, SkillLibIssue, SkillLibOverviewRow } from '../../../shared/types.ts'

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
  // The library lives under the data root, so rooting both at the temp tree puts
  // it beside the homes this file already builds.
  configureAppState(root)
  updateSettings(draft => { draft.dataRoot = root })
  mkdirSync(home(), { recursive: true })
  updateDshState(() => [{ id: 'a', name: 'dsh@a', execPath: '/fake/a', version: 'a', home: home() }])
  registerExtensionsIpc()
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(join(home(), 'cordis.patch.yml'), { force: true })
  rmSync(join(home(), 'profiles'), { recursive: true, force: true })
  rmSync(join(home(), 'skills'), { recursive: true, force: true })
  rmSync(skillLibraryDir(), { recursive: true, force: true })
  mkProfile('default')
})

/** Invoke any registered handler (`handle` wraps every body in an async fn). */
async function call<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  const fn = channels.get(channel)
  if (fn === undefined) throw new Error(`${channel} was not registered`)
  return await fn({}, ...args) as IpcResult<T>
}

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

describe('the dsh-side skill channels', () => {
  const skillsRoot = (): string => join(home(), 'skills')
  const skillFile = (name: string): string => join(skillsRoot(), name, 'SKILL.md')
  const skillText = (name: string, description = `the ${name} skill`): string =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`

  it('creates a skill on the dsh, reads it back, and refuses to overwrite it', async () => {
    expect((await call('ext:skillSave', 'a', null, skillText('demo'))).ok).toBe(true)
    expect(readFileSync(skillFile('demo'), 'utf8')).toContain('name: demo')
    expect(await call<string>('ext:skillRead', 'a', 'demo'))
      .toMatchObject({ ok: true, value: skillText('demo') })

    // A create passes `previousName: null`, so nothing but this guard stands
    // between the new text and the file that is already there.
    expect(await call('ext:skillSave', 'a', null, skillText('demo', 'the impostor')))
      .toMatchObject({ ok: false, code: 'ext.skillExists' })
    expect(readFileSync(skillFile('demo'), 'utf8')).toContain('the demo skill')
  })

  it('saves the scaffold the page starts from, untouched', async () => {
    const scaffold = await call<string>('ext:skillScaffold', 'from-scaffold')
    expect(scaffold.ok).toBe(true)
    const text = scaffold.ok ? scaffold.value : ''
    expect((await call('ext:skillSave', 'a', null, text)).ok).toBe(true)
    expect(existsSync(skillFile('from-scaffold'))).toBe(true)
  })

  it('renames through the frontmatter, leaving the old name free', async () => {
    await call('ext:skillSave', 'a', null, skillText('before-name'))
    expect((await call('ext:skillSave', 'a', 'before-name', skillText('after-name'))).ok).toBe(true)
    expect(existsSync(join(skillsRoot(), 'before-name'))).toBe(false)
    expect(existsSync(skillFile('after-name'))).toBe(true)
  })

  it('refuses a bad name, a non-editable name and an absurd payload', async () => {
    expect(await call('ext:skillRead', 'a', '../escape')).toMatchObject({ ok: false, code: 'ext.badSkill' })
    expect(await call('ext:skillSave', 'a', '../escape', skillText('x')))
      .toMatchObject({ ok: false, code: 'ext.badSkill' })
    // A name that is nowhere on this dsh is a business refusal with its own code,
    // not an `internal` one.
    expect(await call('ext:skillRead', 'a', 'never-created'))
      .toMatchObject({ ok: false, code: 'ext.skillReadOnly' })
    expect(await call('ext:skillSave', 'a', null, 'x'.repeat(300 * 1024)))
      .toMatchObject({ ok: false, code: 'ext.badSkill' })
    expect(existsSync(join(skillsRoot(), 'never-created'))).toBe(false)
  })

  it('imports a zip into the writable root, and refuses a non-zip path', async () => {
    const one = join(root, 'one.zip')
    const arc = new AdmZip()
    arc.addFile('demo/SKILL.md', Buffer.from(skillText('zipped'), 'utf8'))
    arc.writeZip(one)
    const imported = await call<SkillEntry[]>('ext:skillImportZip', 'a', one)
    expect(imported.ok).toBe(true)
    expect(existsSync(skillFile('zipped'))).toBe(true)

    const notes = join(root, 'notes.txt')
    writeFileSync(notes, 'x')
    expect(await call('ext:skillImportZip', 'a', notes))
      .toMatchObject({ ok: false, code: 'ext.skillZipNotZip' })
  })
})

describe('the library channels', () => {
  it('stay ok when one library entry cannot be read', async () => {
    // Both library routes scan the catalog FIRST, so an unguarded read there threw
    // before any per-copy guard could run: the page got one error and rendered
    // nothing, losing every other skill with it. The unreadable entry belongs in
    // the issue list, which is where the page looks for problems.
    const broken = join(skillLibraryDir(), 'notes', 'SKILL.md')
    mkdirSync(broken, { recursive: true })

    const list = await call<{ issues: SkillLibIssue[] }>('ext:libSkillList')
    expect(list.ok).toBe(true)
    expect(list.ok && list.value.issues.map(issue => issue.path)).toEqual([broken])

    const overview = await call<SkillLibOverviewRow[]>('ext:libSkillOverview')
    expect(overview.ok).toBe(true)
  })
})
