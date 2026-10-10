/**
 * The extensions IPC boundary, end to end over a disposable home.
 *
 * Two halves. `ext:mcpSave`'s write guard: a row is INSERTED only when its id is
 * free across the whole resolution — an id that already resolves from another
 * layer (a shipped bundle row, a home row) is refused, because dsh merges rows by
 * id, and the target layer's own row is updated in place instead.
 *
 * And the dsh-side skill channels (`ext:skill*`), which are what make a dsh's
 * skills reachable from the page at all: create from the launcher's scaffold,
 * open a copy in the file manager or the editor, import a zip. Nothing here
 * writes a skill's text — see docs/specs/extensions.md §3.3.
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
import type {
  IpcResult, McpServerInput, SkillEntry, SkillLibEntry, SkillLibIssue, SkillLibOverviewRow, SkillListing,
} from '../../../shared/types.ts'

/** Every registered channel, so a test can invoke one without ipcMain, plus the
 * two `shell` calls the open channels make. */
const channels = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())
const opened = vi.hoisted(() => ({
  openPath: vi.fn(async () => ''),
  openExternal: vi.fn(async () => undefined),
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  dialog: {},
  shell: { openPath: opened.openPath, openExternal: opened.openExternal },
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

  beforeEach(() => {
    opened.openPath.mockClear()
    opened.openExternal.mockClear()
  })

  it('creates a skill from the launcher scaffold, and refuses to overwrite one', async () => {
    const created = await call<SkillEntry>('ext:skillCreate', 'a', 'demo')
    expect(created.ok).toBe(true)
    // What lands is the launcher's own scaffold: a valid file to start from, with
    // the name in its frontmatter. The rest of the bundle is the user's own files.
    const scaffold = readFileSync(skillFile('demo'), 'utf8')
    expect(scaffold).toContain('name: demo')
    expect(created.ok && created.value.name).toBe('demo')

    // Creating over a name the writable root already holds is refused — the
    // launcher never writes over a skill that is there.
    expect(await call('ext:skillCreate', 'a', 'demo')).toMatchObject({ ok: false, code: 'ext.skillExists' })
    expect(readFileSync(skillFile('demo'), 'utf8')).toBe(scaffold)
  })

  it('shows a copy’s folder, and opens the skill itself in the editor', async () => {
    await call('ext:skillCreate', 'a', 'demo')

    expect(await call('ext:skillReveal', 'a', 'demo')).toMatchObject({ ok: true, value: true })
    expect(opened.openPath).toHaveBeenCalledWith(join(skillsRoot(), 'demo'))

    expect(await call('ext:skillOpenEditor', 'a', 'demo')).toMatchObject({ ok: true, value: true })
    // The skill ITSELF, which for a bundle is its folder: the editor opens a folder
    // as a workspace, so the resource files land in the tree beside the SKILL.md.
    // (A protocol URL takes forward slashes on every platform, Windows drives too.)
    expect(opened.openExternal)
      .toHaveBeenCalledWith(`vscode://file/${join(skillsRoot(), 'demo').replace(/\\/g, '/')}`)
  })

  it('opens a flat skill as the file it is, not as the whole root', async () => {
    // A flat `<name>.md` has no folder of its own: its directory IS the root, and a
    // workspace over the root would be every other skill, not this one.
    mkdirSync(skillsRoot(), { recursive: true })
    const flat = join(skillsRoot(), 'flat-demo.md')
    writeFileSync(flat, skillText('flat-demo'))

    expect(await call('ext:skillOpenEditor', 'a', 'flat-demo')).toMatchObject({ ok: true, value: true })
    expect(opened.openExternal).toHaveBeenCalledWith(`vscode://file/${flat.replace(/\\/g, '/')}`)
  })

  it('opens a copy in a root the launcher may not write', async () => {
    // The copies worth looking at are exactly the ones the launcher cannot touch:
    // reading a skill is not writing one.
    const agentsRoot = join(home(), 'agents-home', 'skills')
    mkdirSync(join(agentsRoot, 'foreign'), { recursive: true })
    writeFileSync(join(agentsRoot, 'foreign', 'SKILL.md'), skillText('foreign'))
    process.env.DSH_AGENTS_HOME = join(home(), 'agents-home')
    try {
      const list = await call<SkillListing>('ext:skillList', 'a')
      expect(list.ok && list.value.skills.find(skill => skill.name === 'foreign')?.editable).toBe(false)
      expect(await call('ext:skillReveal', 'a', 'foreign')).toMatchObject({ ok: true, value: true })
      expect(opened.openPath).toHaveBeenCalledWith(join(agentsRoot, 'foreign'))
    } finally {
      delete process.env.DSH_AGENTS_HOME
    }
  })

  it('refuses a bad name, a missing one, and a profile that is not there', async () => {
    expect(await call('ext:skillReveal', 'a', '../escape')).toMatchObject({ ok: false, code: 'ext.badSkill' })
    expect(await call('ext:skillOpenEditor', 'a', '../escape')).toMatchObject({ ok: false, code: 'ext.badSkill' })
    expect(await call('ext:skillCreate', 'a', '../escape')).toMatchObject({ ok: false, code: 'ext.badSkill' })
    // A name that is nowhere on this dsh is a business refusal with its own code,
    // not an `internal` one.
    expect(await call('ext:skillReveal', 'a', 'never-created'))
      .toMatchObject({ ok: false, code: 'ext.skillNotFound' })
    expect(await call('ext:skillOpenEditor', 'a', 'never-created'))
      .toMatchObject({ ok: false, code: 'ext.skillNotFound' })
    expect(opened.openPath).not.toHaveBeenCalled()
    expect(opened.openExternal).not.toHaveBeenCalled()
    // The profile is the scope the listing was read with: a name that is not there
    // must not degrade into "this dsh, no preset roots" — that reads like "this
    // deployment contributes no skills".
    expect(await call('ext:skillReveal', 'a', 'never-created', 'no-such-profile'))
      .toMatchObject({ ok: false, code: 'profile.notFound' })
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

  it('creates a library skill and opens it on the same two verbs as a dsh copy', async () => {
    const created = await call<SkillLibEntry>('ext:libSkillCreate', 'notes')
    expect(created.ok).toBe(true)
    expect(existsSync(join(skillLibraryDir(), 'notes', 'SKILL.md'))).toBe(true)
    expect(await call('ext:libSkillCreate', 'notes')).toMatchObject({ ok: false, code: 'ext.skillExists' })

    expect(await call('ext:libSkillReveal', 'notes')).toMatchObject({ ok: true, value: true })
    expect(opened.openPath).toHaveBeenCalledWith(join(skillLibraryDir(), 'notes'))
    expect(await call('ext:libSkillOpenEditor', 'notes')).toMatchObject({ ok: true, value: true })
    // Same rule as a dsh copy: the bundle's folder, opened as a workspace.
    expect(opened.openExternal).toHaveBeenCalledWith(
      `vscode://file/${join(skillLibraryDir(), 'notes').replace(/\\/g, '/')}`,
    )
    // Gone between the render and the click is a business answer here too.
    expect(await call('ext:libSkillReveal', 'never-here')).toMatchObject({ ok: false, code: 'ext.skillNotFound' })
  })
})
