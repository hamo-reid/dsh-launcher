/**
 * The launcher-global skill library: settings-free CRUD inside the wired
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
  deleteSkillLib, installSkillToDsh, listSkillLibrary, readSkillLibFile, scanSkillInstalls,
  setSkillLibraryDir, setSkillLibraryTrash, skillLibraryDir, skillLibTextOf, writeSkillLib,
} from './skill-library.ts'
import { contextForEntry, updateDshState } from './appState.ts'
import { AppError } from './errors.ts'
import { openDatabase } from './settings.ts'

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

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-skill-lib-'))
  lib = join(root, 'library')
  home = join(root, 'home')
  trashDir = join(root, 'trash')
  mkdirSync(home, { recursive: true })
  await openDatabase(join(root, 'app.sqlite'))
  updateDshState(dshes => [...dshes, ENTRY()])
  setSkillLibraryDir(lib)
  setSkillLibraryTrash(async target => {
    mkdirSync(trashDir, { recursive: true })
    renameSync(target, join(trashDir, target.split(/[\\/]/).pop() ?? target))
  })
}, 20000)

afterAll(() => {
  setSkillLibraryTrash(null)
  setSkillLibraryDir(null)
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

  it('write creates a bundle; read returns the full text', () => {
    const entry = writeSkillLib(null, makeSkill('greeter'))
    expect(entry.name).toBe('greeter')
    expect(entry.path).toBe(join(lib, 'greeter', 'SKILL.md'))
    expect(readSkillLibFile('greeter').text).toBe(makeSkill('greeter'))
    expect(listSkillLibrary().skills.map(s => s.name)).toEqual(['greeter'])
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
    expect(readSkillLibFile('flat-edit').text).toContain('edited in place')
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
})
