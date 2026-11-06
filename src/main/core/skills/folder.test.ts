/**
 * Folder import: the shape rules (a folder is one bundle, or the parent of
 * several — one level deep, never deeper), the copy semantics (a snapshot under
 * the FRONTMATTER name, resources carried with it), the two-pass refusals it
 * shares with the zip path, and the one hazard only a folder has: a destination
 * that sits inside its own source.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '../shared/errors.ts'
import { renderSkillFile } from './frontmatter.ts'
import { folderImportProblem, installFolderSkills, skillFolderDirs } from './folder.ts'

let root: string
let target: string

const makeSkill = (name: string, description = `the ${name} skill`): string =>
  renderSkillFile({ name, description, modelInvocable: true, userInvocable: true, body: `do ${name}` })

/** A folder holding the given files (relative paths, directories created). */
function folder(name: string, files: Record<string, string>): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

/** The code an install throws, or a marker when it threw something else. The
 * default probe asks the target root, which is what a caller does; a test that
 * wants the filesystem to be the only guard passes `() => false`. */
function codeOf(source: string, probe?: (name: string) => boolean): string {
  try {
    installFolderSkills(target, source, probe ?? (name => existsSync(join(target, name))))
    return '(no throw)'
  } catch (error) {
    return error instanceof AppError ? error.code : `not-app:${String(error)}`
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pm-skill-folder-'))
  target = join(root, 'target')
})

beforeEach(() => {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the shape a folder carries', () => {
  it('reads a folder with its own SKILL.md as ONE bundle', () => {
    // Everything else in the folder is that skill's resources, so the folder is
    // not a container of skills — it IS the skill.
    const dir = folder('single', { 'SKILL.md': makeSkill('solo'), 'scripts/run.ps1': 'Write-Output hi' })
    expect(skillFolderDirs(dir)).toEqual([dir])
  })

  it('reads the bundles one level down, and only one level', () => {
    const parent = folder('parent', {
      'a/SKILL.md': makeSkill('a'),
      'b/SKILL.md': makeSkill('b'),
      // A bundle nested inside another skill's directory is that skill's resource,
      // and a level below the parent is not this import's business.
      'b/deep/SKILL.md': makeSkill('deep'),
      'not-a-skill/README.md': 'nothing here',
    })
    expect(skillFolderDirs(parent)).toEqual([join(parent, 'a'), join(parent, 'b')])
  })

  it('ignores flat .md files: a folder import reads bundles', () => {
    // A flat `<name>.md` is a skill the ROOTS accept; adding one from a folder is
    // deliberately out of scope, so a folder of loose notes is not a skill batch.
    const dir = folder('flat', { 'notes.md': makeSkill('notes') })
    expect(skillFolderDirs(dir)).toEqual([])
  })
})

describe('folder import', () => {
  it('installs under the FRONTMATTER name, carrying the resources', () => {
    const source = folder('whatever-name', {
      'SKILL.md': makeSkill('renamed'),
      'references/ref.md': 'see also',
    })
    const installed = installFolderSkills(target, source, () => false)
    expect(installed.map(entry => entry.skill.name)).toEqual(['renamed'])
    expect(installed[0].dir).toBe(join(target, 'renamed'))
    expect(readFileSync(join(target, 'renamed', 'SKILL.md'), 'utf8')).toContain('name: renamed')
    // The copy is the WHOLE folder: a skill is not only its SKILL.md.
    expect(readFileSync(join(target, 'renamed', 'references', 'ref.md'), 'utf8')).toBe('see also')
    // The source is untouched — an import copies.
    expect(existsSync(join(source, 'SKILL.md'))).toBe(true)
  })

  it('installs every bundle a parent folder holds', () => {
    const parent = folder('both', { 'a/SKILL.md': makeSkill('one'), 'b/SKILL.md': makeSkill('two') })
    expect(installFolderSkills(target, parent, () => false).map(entry => entry.skill.name)).toEqual(['one', 'two'])
    expect(existsSync(join(target, 'one', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(target, 'two', 'SKILL.md'))).toBe(true)
  })

  it('refuses a folder with no SKILL.md', () => {
    const dir = folder('empty', { 'readme.txt': 'nothing' })
    expect(codeOf(dir)).toBe('ext.skillFolderNoSkill')
  })

  it('is all-or-nothing: one bad skill fails the whole folder', () => {
    const parent = folder('mixed', {
      'good/SKILL.md': makeSkill('folder-good'),
      'bad/SKILL.md': '---\nname: folder-bad\n---\n', // no description
    })
    expect(codeOf(parent)).toBe('ext.badSkill')
    expect(existsSync(join(target, 'folder-good'))).toBe(false)
  })

  it('refuses a name the target already holds, leaving it alone', () => {
    mkdirSync(join(target, 'taken'), { recursive: true })
    writeFileSync(join(target, 'taken', 'SKILL.md'), makeSkill('taken', 'the original'))
    const source = folder('collide', { 'SKILL.md': makeSkill('taken') })
    expect(codeOf(source)).toBe('ext.skillExists')
    expect(readFileSync(join(target, 'taken', 'SKILL.md'), 'utf8')).toContain('the original')
  })

  it('refuses duplicate names within one folder', () => {
    const parent = folder('dupe', { 'a/SKILL.md': makeSkill('same'), 'b/SKILL.md': makeSkill('same') })
    expect(codeOf(parent)).toBe('ext.skillExists')
  })

  it('lets the filesystem refuse a destination the probe called free', () => {
    // The probe is the caller's own query; `errorOnExist` + `force: false` are what
    // hold when it lies (a name can appear between the check and the copy).
    const source = folder('occupied', { 'SKILL.md': makeSkill('occupied-skill') })
    mkdirSync(join(target, 'occupied-skill'), { recursive: true })
    writeFileSync(join(target, 'occupied-skill', 'SKILL.md'), makeSkill('occupied-skill', 'the original'))
    expect(codeOf(source, () => false)).not.toBe('(no throw)')
    expect(readFileSync(join(target, 'occupied-skill', 'SKILL.md'), 'utf8')).toContain('the original')
  })

  it('rolls back what landed when a later copy fails', () => {
    // `a` copies first, `b` hits a file sitting where its directory would go.
    const parent = folder('partial', {
      'a/SKILL.md': makeSkill('a-skill'),
      'b/SKILL.md': makeSkill('b-skill'),
    })
    writeFileSync(join(target, 'b-skill'), 'in the way')
    expect(codeOf(parent, () => false)).not.toBe('(no throw)')
    expect(existsSync(join(target, 'a-skill'))).toBe(false)
    expect(readFileSync(join(target, 'b-skill'), 'utf8')).toBe('in the way')
  })

  it('refuses a destination that sits inside its own source', () => {
    // `cpSync` would copy the folder into its own descendant until the path gets
    // too long — the one hazard a zip cannot have (its staging lives in tmpdir).
    const self = folder('self', { 'SKILL.md': makeSkill('nested-skill') })
    let code = ''
    try {
      installFolderSkills(self, self, () => false)
    } catch (error) {
      code = error instanceof AppError ? error.code : `not-app:${String(error)}`
    }
    expect(code).toBe('ext.skillFolderNested')
    expect(existsSync(join(self, 'nested-skill'))).toBe(false)
  })
})

describe('folder import pre-flight', () => {
  it('rejects a missing path and a plain file', () => {
    expect(folderImportProblem(join(root, 'no-such-folder'))).toEqual(
      { code: 'ext.skillFolderMissing', detail: join(root, 'no-such-folder') },
    )
    const file = join(root, 'a-file.txt')
    writeFileSync(file, 'text')
    expect(folderImportProblem(file)?.code).toBe('ext.skillFolderMissing')
  })

  it('passes a real directory through to the installer', () => {
    expect(folderImportProblem(folder('preflight', { 'SKILL.md': makeSkill('preflight-ok') }))).toBeNull()
  })
})
