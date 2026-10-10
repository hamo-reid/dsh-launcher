/**
 * The launcher-global skill library: CRUD inside the data-root-derived
 * library dir (dsh-agnostic), acceptance rules shared with the skills track,
 * recycle-bin delete, zip import into the library, install-to-dsh as a plain
 * directory copy (with an explicit overwrite for reinstalls), and drift
 * detection between the library text and installed copies.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderSkillFile, installedEntry, installZipSkills, parseSkillText, writableSkillRoot } from './skills.ts'
import {
  deleteSkillLib, findSkillLibEntry, installSkillToDsh, listSkillLibrary, scanSkillInstalls,
  setSkillLibraryTrash, skillLibraryDir, skillLibShape, skillLibTextOf, writeSkillLib,
} from './library.ts'
import { configureAppState, contextForEntry, updateDshState } from '../profile/appState.ts'
import { AppError } from '../shared/errors.ts'
import { openDatabase, updateSettings } from '../settings/settings.ts'

let root: string
let lib: string
let home: string
let trashDir: string

const ENTRY = (): Parameters<typeof contextForEntry>[0] => ({ id: 'd1', name: 'd1', execPath: 'd1', version: '', home })

function makeSkill(name: string, description = `the ${name} skill`, body = ''): string {
  return renderSkillFile({ name, description, modelInvocable: true, userInvocable: true, body: body === '' ? `do ${name}` : body })
}

function writeLib(name: string, text: string): void {
  mkdirSync(join(lib, name), { recursive: true })
  writeFileSync(join(lib, name, 'SKILL.md'), text)
}

/** One library bundle's SKILL.md text, read off the disk (the library has no
 * reader of its own any more: nothing in the launcher edits a skill's text). */
const readLib = (name: string): string => readFileSync(join(lib, name, 'SKILL.md'), 'utf8')

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-skill-lib-'))
  // The library is `<dataRoot>/skill-library`, so rooting the data root at the
  // temp tree puts it exactly where the old injection used to point.
  lib = join(root, 'skill-library')
  home = join(root, 'home')
  trashDir = join(root, 'trash')
  mkdirSync(home, { recursive: true })
  await openDatabase(join(root, 'app.sqlite'))
  configureAppState(root)
  updateSettings(draft => { draft.dataRoot = root })
  updateDshState(dshes => [...dshes, ENTRY()])
  setSkillLibraryTrash(async target => {
    mkdirSync(trashDir, { recursive: true })
    renameSync(target, join(trashDir, target.split(/[\\/]/).pop() ?? target))
  })
}, 20000)

afterAll(() => {
  setSkillLibraryTrash(null)
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(lib, { recursive: true, force: true })
  rmSync(join(home, 'skills'), { recursive: true, force: true })
  rmSync(trashDir, { recursive: true, force: true })
})

describe('skill library CRUD', () => {
  it('starts empty and creates the dir on first scan', () => {
    expect(listSkillLibrary()).toEqual({ skills: [], issues: [] })
    expect(existsSync(skillLibraryDir())).toBe(true)
  })

  it('write creates a bundle; the file holds the text', () => {
    const entry = writeSkillLib(null, makeSkill('greeter'))
    expect(entry.name).toBe('greeter')
    expect(entry.path).toBe(join(lib, 'greeter', 'SKILL.md'))
    expect(readLib('greeter')).toBe(makeSkill('greeter'))
    expect(listSkillLibrary().skills.map(s => s.name)).toEqual(['greeter'])
  })

  it('finds one entry by name — what the page opens — and answers undefined when it is gone', () => {
    writeSkillLib(null, makeSkill('greeter'))
    expect(findSkillLibEntry('greeter')?.path).toBe(join(lib, 'greeter', 'SKILL.md'))
    expect(findSkillLibEntry('never-here')).toBeUndefined()
  })

  it('editing the frontmatter name renames the bundle dir', () => {
    writeSkillLib(null, makeSkill('greeter'))
    writeSkillLib('greeter', makeSkill('greeter-2'))
    expect(existsSync(join(lib, 'greeter'))).toBe(false)
    expect(listSkillLibrary().skills.map(s => s.name)).toEqual(['greeter-2'])
  })

  it('rejects an invalid skill text and a name collision', () => {
    expect(() => writeSkillLib(null, 'not a skill')).toThrow()
    writeSkillLib(null, makeSkill('greeter'))
    expect(() => writeSkillLib(null, makeSkill('greeter'))).toThrow(AppError)
  })

  it('saving a flat skill in place upgrades it to a bundle and drops the flat file', () => {
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'flat-edit.md'), makeSkill('flat-edit'))
    writeSkillLib('flat-edit', makeSkill('flat-edit', 'edited in place'))
    expect(existsSync(join(lib, 'flat-edit.md'))).toBe(false)
    expect(existsSync(join(lib, 'flat-edit', 'SKILL.md'))).toBe(true)
    // One skill, not two: the flat file no longer doubles the entry.
    expect(listSkillLibrary().skills.map(s => s.name)).toEqual(['flat-edit'])
    expect(readLib('flat-edit')).toContain('edited in place')
  })

  it('installs a flat library entry as a flat copy, and reinstalls across shapes', () => {
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'notes.md'), makeSkill('notes'))
    const flat = listSkillLibrary().skills[0]
    const target = writableSkillRoot(contextForEntry(ENTRY()))
    const dest = installSkillToDsh(target, flat, false)
    expect(dest).toBe(join(target, 'notes.md'))
    // dsh discovers the flat copy, and the launcher reports it as fresh.
    expect(scanSkillInstalls(flat)[0]).toMatchObject({ installed: true, stale: false })
    // Reinstalling without overwrite is refused…
    expect(() => installSkillToDsh(target, flat, false)).toThrow(AppError)
    // …and with it, the fresh copy replaces the old one.
    writeFileSync(join(lib, 'notes.md'), makeSkill('notes', 'the notes skill', 'updated'))
    const updated = listSkillLibrary().skills[0]
    expect(installSkillToDsh(target, updated, true)).toBe(join(target, 'notes.md'))
    expect(readFileSync(join(target, 'notes.md'), 'utf8')).toContain('updated')
    expect(scanSkillInstalls(updated)[0]).toMatchObject({ installed: true, stale: false })
  })

  it('a flat install replaces a bundle copy of the same name (and vice versa)', () => {
    const bundle = writeSkillLib(null, makeSkill('greeter'))
    const target = writableSkillRoot(contextForEntry(ENTRY()))
    installSkillToDsh(target, bundle, false)
    expect(existsSync(join(target, 'greeter', 'SKILL.md'))).toBe(true)
    // The same name now exists in the library as a flat entry: installing it must
    // replace the bundle copy, not sit next to it (dsh would see two skills).
    rmSync(join(lib, 'greeter'), { recursive: true, force: true })
    writeFileSync(join(lib, 'greeter.md'), makeSkill('greeter'))
    const flat = listSkillLibrary().skills[0]
    expect(skillLibShape(flat)).toBe('flat')
    installSkillToDsh(target, flat, true)
    expect(existsSync(join(target, 'greeter'))).toBe(false)
    expect(existsSync(join(target, 'greeter.md'))).toBe(true)
  })

  it('delete moves the whole bundle to the recycle bin', async () => {
    writeLib('greeter', makeSkill('greeter'))
    writeFileSync(join(lib, 'greeter', 'helper.sh'), 'echo hi')
    await deleteSkillLib('greeter')
    expect(existsSync(join(lib, 'greeter'))).toBe(false)
    expect(existsSync(join(trashDir, 'greeter'))).toBe(true)
  })

  it('surfaces unparseable files as issues instead of dropping them', () => {
    writeLib('ok', makeSkill('ok'))
    mkdirSync(join(lib, 'broken'), { recursive: true })
    writeFileSync(join(lib, 'broken', 'SKILL.md'), 'no frontmatter here')
    const { skills, issues } = listSkillLibrary()
    expect(skills.map(s => s.name)).toEqual(['ok'])
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toBe(join(lib, 'broken', 'SKILL.md'))
  })
})

describe('zip import into the library', () => {
  it('installs every skill the zip carries into the library dir', () => {
    const zip = new AdmZip()
    zip.addFile('a/SKILL.md', Buffer.from(makeSkill('skill-a')))
    zip.addFile('wrapper-main/b/SKILL.md', Buffer.from(makeSkill('skill-b')))
    const zipPath = join(root, 'skills.zip')
    zip.writeZip(zipPath)
    const installed = installZipSkills(lib, zipPath, name => existsSync(join(lib, name)))
    expect(installed.map(i => i.skill.name).sort()).toEqual(['skill-a', 'skill-b'])
    expect(existsSync(join(lib, 'skill-a', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(lib, 'skill-b', 'SKILL.md'))).toBe(true)
  })

  it('refuses to overwrite an existing library entry (all-or-nothing)', () => {
    writeLib('skill-a', makeSkill('skill-a', 'ORIGINAL'))
    const zip = new AdmZip()
    zip.addFile('a/SKILL.md', Buffer.from(makeSkill('skill-a', 'NEWER')))
    zip.addFile('b/SKILL.md', Buffer.from(makeSkill('skill-b')))
    const zipPath = join(root, 'skills.zip')
    zip.writeZip(zipPath)
    expect(() => installZipSkills(lib, zipPath, name => existsSync(join(lib, name)))).toThrow(AppError)
    // Nothing landed: the zip carried two skills, one collided.
    expect(existsSync(join(lib, 'skill-b'))).toBe(false)
    expect(readFileSync(join(lib, 'skill-a', 'SKILL.md'), 'utf8')).toContain('ORIGINAL')
  })
})

describe('install to dsh (copy semantics)', () => {
  it('copies the bundle into the dsh writable root and dsh discovers it', () => {
    const libEntry = writeSkillLib(null, makeSkill('greeter'))
    const dest = installSkillToDsh(writableSkillRoot(contextForEntry(ENTRY())), libEntry, false)
    expect(dest).toBe(join(home, 'skills', 'greeter'))
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe(makeSkill('greeter'))
    const installed = parseSkillText(skillLibTextOf(libEntry))
    if (!installed.ok) throw new Error('library text should parse')
    expect(installedEntry(installed.skill, writableSkillRoot(contextForEntry(ENTRY()))).name).toBe('greeter')
  })

  it('fails on an existing copy unless overwrite is requested', () => {
    const libEntry = writeSkillLib(null, makeSkill('greeter'))
    const target = writableSkillRoot(contextForEntry(ENTRY()))
    installSkillToDsh(target, libEntry, false)
    expect(() => installSkillToDsh(target, libEntry, false)).toThrow(AppError)
    installSkillToDsh(target, libEntry, true) // reinstall
    expect(readFileSync(join(target, 'greeter', 'SKILL.md'), 'utf8')).toBe(makeSkill('greeter'))
  })

  it('overwrite replaces a stale copy whole (removed files do not survive)', () => {
    const libEntry = writeSkillLib(null, makeSkill('greeter'))
    const target = writableSkillRoot(contextForEntry(ENTRY()))
    installSkillToDsh(target, libEntry, false)
    writeFileSync(join(target, 'greeter', 'stale-extra.txt'), 'old resource')
    // The library now no longer carries that resource.
    const fresh = writeSkillLib('greeter', makeSkill('greeter', 'the greeter skill', 'updated body'))
    installSkillToDsh(target, fresh, true)
    expect(existsSync(join(target, 'greeter', 'stale-extra.txt'))).toBe(false)
    expect(readFileSync(join(target, 'greeter', 'SKILL.md'), 'utf8')).toContain('updated body')
  })
})

describe('drift detection (scanSkillInstalls)', () => {
  it('reports not-installed dshs, fresh copies, and stale ones', () => {
    const libEntry = writeSkillLib(null, makeSkill('greeter'))
    // No dsh holds a copy yet.
    expect(scanSkillInstalls(libEntry)).toEqual([
      { dshId: 'd1', dshName: 'd1', installed: false, stale: false },
    ])
    const target = writableSkillRoot(contextForEntry(ENTRY()))
    installSkillToDsh(target, libEntry, false)
    expect(scanSkillInstalls(libEntry)[0]).toMatchObject({ installed: true, stale: false })
    // The library moves ahead; the installed copy is now stale.
    writeSkillLib('greeter', makeSkill('greeter', 'the greeter skill', 'updated body'))
    expect(scanSkillInstalls(listSkillLibrary().skills[0])[0]).toMatchObject({ installed: true, stale: true })
  })

  it('treats a same-name discovered entry as the installed copy', () => {
    const libEntry = writeSkillLib(null, makeSkill('greeter'))
    // Installed by hand as a flat file — still counts, and still drifts.
    mkdirSync(join(home, 'skills'), { recursive: true })
    writeFileSync(join(home, 'skills', 'greeter.md'), makeSkill('greeter', 'a different text'))
    const installs = scanSkillInstalls(libEntry)
    expect(installs[0]).toMatchObject({ installed: true, stale: true })
    expect(installs[0].entry?.path).toBe(join(home, 'skills', 'greeter.md'))
  })

  it('scans a flat library entry without reading the library root as a bundle', () => {
    // A hand-dropped `<name>.md` is a supported shape (editing one upgrades it
    // to a bundle), and its `dir` is the library ROOT — so a scanner joining
    // `dir` + SKILL.md reads `<root>/SKILL.md` and throws, which fails the
    // whole overview call: every entry is scanned in one map.
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'notes.md'), makeSkill('notes'))
    const entry = listSkillLibrary().skills.find(s => s.name === 'notes')
    if (entry === undefined) throw new Error('flat entry was not listed')
    expect(entry.dir).toBe(skillLibraryDir())
    expect(skillLibTextOf(entry)).toContain('do notes')
    // Installed by hand as a flat file as well: found, and judged fresh.
    mkdirSync(join(home, 'skills'), { recursive: true })
    writeFileSync(join(home, 'skills', 'notes.md'), makeSkill('notes'))
    expect(scanSkillInstalls(entry)[0]).toMatchObject({ installed: true, stale: false })
    // A bundle entry still reads its own SKILL.md.
    expect(skillLibTextOf(writeSkillLib(null, makeSkill('greeter')))).toContain('do greeter')
  })

  it('drift is judged on the writable-root copy, even when a higher-precedence root shadows it', () => {
    const custom = join(root, 'custom-skills')
    mkdirSync(join(custom, 'greeter'), { recursive: true })
    writeFileSync(join(custom, 'greeter', 'SKILL.md'), makeSkill('greeter', 'CUSTOM COPY'))
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: skills',
      `  name: '@deepseek-ai/dsh-skill-filesystem'`,
      '  config:',
      '    customSkillDirs:',
      `      - ${custom}`,
      '',
    ].join('\n'))
    try {
      const libEntry = writeSkillLib(null, makeSkill('greeter', 'LIBRARY COPY'))
      const target = writableSkillRoot(contextForEntry(ENTRY()))
      installSkillToDsh(target, libEntry, false)
      // The custom root outranks user-dsh, but the launcher can only manage the
      // writable copy — so the fresh install must NOT read as stale.
      const installs = scanSkillInstalls(libEntry)
      expect(installs[0]).toMatchObject({ installed: true, stale: false })
      expect(installs[0].entry?.source).toBe('user-dsh')
    } finally {
      rmSync(join(home, 'cordis.patch.yml'), { force: true })
      rmSync(custom, { recursive: true, force: true })
    }
  })

  it('degrades one unreadable copy instead of failing the whole overview', () => {
    // `scanSkillInstalls` maps EVERY library entry across EVERY dsh, so one
    // unreadable file used to fail the call and hide every other skill on every
    // other dsh. A file that cannot be read is a file dsh does not load either,
    // so it surfaces as an issue and its own cell reads as not-installed —
    // while its neighbours still get real verdicts on the same pass.
    const greeter = writeSkillLib(null, makeSkill('greeter'))
    const broken = writeSkillLib(null, makeSkill('broken'))
    const target = writableSkillRoot(contextForEntry(ENTRY()))
    installSkillToDsh(target, greeter, false)
    installSkillToDsh(target, broken, false)
    // A directory where the entry claims a file: the scan sees it, the read does not.
    const brokenCopy = join(target, 'broken', 'SKILL.md')
    rmSync(brokenCopy)
    mkdirSync(brokenCopy, { recursive: true })

    expect(scanSkillInstalls(broken)[0]).toMatchObject({ installed: false, stale: false })
    const greeterRow = scanSkillInstalls(greeter)
    expect(greeterRow[0]).toMatchObject({ installed: true, stale: false })
    expect(greeterRow[0].problem).toBeUndefined()
  })

  it('degrades a library entry whose own file cannot be read', () => {
    const entry = writeSkillLib(null, makeSkill('notes'))
    rmSync(join(lib, 'notes', 'SKILL.md'))
    mkdirSync(join(lib, 'notes', 'SKILL.md'), { recursive: true })
    // Nothing is installed, and the comparison never happened — the cell says so
    // instead of claiming the copy is current.
    const rows = scanSkillInstalls(entry)
    expect(rows[0]).toMatchObject({ installed: false, stale: false })
    expect(rows[0].problem).toContain('library entry cannot be read')
  })

  it('reports an unreadable entry as an ISSUE, not as a failed catalog', () => {
    // The entry that cannot be read is named where the user looks for problems,
    // and its readable neighbours keep their verdicts. Before this, the read threw
    // out of `listSkillLibrary`, so both library IPC routes failed and the whole
    // page rendered nothing at all — the per-copy guard downstream never ran.
    writeSkillLib(null, makeSkill('greeter'))
    writeSkillLib(null, makeSkill('notes'))
    rmSync(join(lib, 'notes', 'SKILL.md'))
    mkdirSync(join(lib, 'notes', 'SKILL.md'), { recursive: true })

    const scanned = listSkillLibrary()
    expect(scanned.skills.map(entry => entry.name)).toEqual(['greeter'])
    expect(scanned.issues).toHaveLength(1)
    expect(scanned.issues[0].path).toBe(join(lib, 'notes', 'SKILL.md'))
    expect(scanned.issues[0].reason).toContain('cannot be read')
  })

  it('still says a copy exists when only the entry went unreadable', () => {
    // The cell's job is to describe THIS dsh. With the entry gone unreadable
    // mid-flight, installedness is still answerable and staleness is not, so the
    // answer is "there is a copy, and we cannot tell whether it is current" —
    // never "not installed" for a dsh that visibly has the skill.
    const entry = writeSkillLib(null, makeSkill('notes'))
    const target = writableSkillRoot(contextForEntry(ENTRY()))
    installSkillToDsh(target, entry, false)
    rmSync(join(lib, 'notes', 'SKILL.md'))
    mkdirSync(join(lib, 'notes', 'SKILL.md'), { recursive: true })

    const rows = scanSkillInstalls(entry)
    expect(rows[0]).toMatchObject({ installed: true, stale: true })
    expect(rows[0].entry?.name).toBe('notes')
    expect(rows[0].problem).toContain('library entry cannot be read')
  })
})
