/**
 * Behavior tests for the skills track: root resolution (config row + defaults),
 * dsh-mirroring frontmatter acceptance, listing with issues, and write / rename
 * / recycle-bin delete confined to the writable user-dsh root.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextForEntry } from './appState.ts'
import {
  deleteSkill, findEditableSkill, listSkills, parseSkillText, readSkillFile, renderSkillFile, scaffoldSkill,
  setSkillTrash, skillRoots, writeSkill,
} from './skills.ts'
import type { DshContext } from './appState.ts'

let root: string
let home: string
let agents: string
let custom: string
let trashDir: string

const ctx = (): DshContext =>
  contextForEntry({ id: 'd1', name: 'd1', execPath: 'd1', version: '', home })

function skill(name: string, text: string, flat = false): void {
  const dir = join(home, 'skills')
  mkdirSync(dir, { recursive: true })
  if (flat) writeFileSync(join(dir, `${name}.md`), text)
  else {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, 'SKILL.md'), text)
  }
}

function makeSkill(name: string, description = `the ${name} skill`): string {
  return renderSkillFile({ name, description, modelInvocable: true, userInvocable: true, body: `do ${name}` })
}

const USER_DSH = (): string => join(home, 'skills')

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pm-skills-'))
  home = join(root, 'home')
  agents = join(root, 'agents')
  custom = join(root, 'custom-skills')
  trashDir = join(root, 'trash')
  mkdirSync(home, { recursive: true })
  mkdirSync(agents, { recursive: true })
  // Pin the agents root away from the real `~/.agents` so listing never sees it.
  process.env.DSH_AGENTS_HOME = agents
  // A fake recycle bin: rename into the tmp trash dir (the real mover is
  // Electron's shell.trashItem, wired in main).
  setSkillTrash(async target => {
    mkdirSync(trashDir, { recursive: true })
    renameSync(target, join(trashDir, target.split(/[\\/]/).pop() ?? target))
  })
})

afterAll(() => {
  delete process.env.DSH_AGENTS_HOME
  setSkillTrash(null)
  rmSync(root, { recursive: true, force: true })
})

// Tests share one tmp home; a home-layer config row written by one test must
// not leak the roots it declares into the next.
beforeEach(() => {
  const patch = join(home, 'cordis.patch.yml')
  if (existsSync(patch)) rmSync(patch)
})

describe('root resolution', () => {
  it('resolves the writable user-dsh root under the dsh home and the agents root from the env', () => {
    const roots = skillRoots(ctx())
    expect(roots.map(r => r.root)).toEqual(['user-dsh', 'user-agents'])
    const userDsh = roots.find(r => r.root === 'user-dsh')
    expect(userDsh?.path).toBe(USER_DSH())
    expect(userDsh?.writable).toBe(true)
    expect(roots.find(r => r.root === 'user-agents')?.path).toBe(join(agents, 'skills'))
  })

  it('reads customSkillDirs from the home-layer skill-filesystem row', () => {
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: skills',
      `  name: '@deepseek-ai/dsh-skill-filesystem'`,
      '  config:',
      '    customSkillDirs:',
      `      - ${custom}`,
      '',
    ].join('\n'))
    const roots = skillRoots(ctx())
    expect(roots.map(r => r.root)).toEqual(['custom:0', 'user-dsh', 'user-agents'])
    expect(roots[0]).toMatchObject({ source: 'custom', path: custom, writable: false })
  })

  it('drops the default roots when the config row says so', () => {
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: skills',
      `  name: '@deepseek-ai/dsh-skill-filesystem'`,
      '  config:',
      '    includeDefaultRoots: false',
      `    customSkillDirs: [${custom}]`,
      '',
    ].join('\n'))
    expect(skillRoots(ctx()).map(r => r.root)).toEqual(['custom:0'])
  })
})

describe('frontmatter acceptance (mirrors dsh)', () => {
  it('accepts a canonical file', () => {
    const parsed = parseSkillText(makeSkill('code-review'))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.skill.name).toBe('code-review')
      expect(parsed.skill.modelInvocable).toBe(true)
      expect(parsed.skill.userInvocable).toBe(true)
    }
  })

  it('renders → parses as a round-trip, including the off switches', () => {
    const text = renderSkillFile({
      name: 'deep-dive', description: "goes deeper: than bare scalars allow", whenToUse: 'when asked',
      modelInvocable: false, userInvocable: false, body: 'body text',
    })
    expect(text).toContain('disable-model-invocation: true')
    expect(text).toContain('user-invocable: false')
    const parsed = parseSkillText(text)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.skill.description).toBe('goes deeper: than bare scalars allow')
      expect(parsed.skill.whenToUse).toBe('when asked')
      expect(parsed.skill.modelInvocable).toBe(false)
      expect(parsed.skill.userInvocable).toBe(false)
    }
  })

  it('rejects what dsh rejects, with a reason', () => {
    expect(parseSkillText('no frontmatter here').ok).toBe(false)
    expect(parseSkillText('---\nname: x\n---\nbody').ok).toBe(false) // no description
    expect(parseSkillText(makeSkill('Bad_Name')).ok).toBe(false) // name rule
    expect(parseSkillText(makeSkill('-leading')).ok).toBe(false)
    // Legacy camelCase invocation keys are rejected (dsh refuses them too).
    expect(parseSkillText('---\nname: a\ndescription: b\ndisableModelInvocation: true\n---\n').ok).toBe(false)
    // Boolean-ish values parse; garbage does not.
    expect(parseSkillText('---\nname: a\ndescription: b\nuser-invocable: \'no\'\n---\n').ok).toBe(true)
    expect(parseSkillText('---\nname: a\ndescription: b\nuser-invocable: sometimes\n---\n').ok).toBe(false)
  })

  it('scaffolds a file that parses', () => {
    const parsed = parseSkillText(scaffoldSkill('my-skill'))
    expect(parsed.ok).toBe(true)
  })
})

describe('listing', () => {
  it('lists bundles and flat files by rank, skips .system, and reports broken files as issues', () => {
    skill('alpha', makeSkill('alpha'))
    skill('beta', makeSkill('beta'), true)
    skill('.system', makeSkill('system-internal'))
    skill('broken', '---\nname: broken\n---\n') // no description → dsh ignores it
    const listing = listSkills(ctx())
    const mine = listing.skills.filter(s => s.source === 'user-dsh')
    expect(mine.map(s => s.name)).toEqual(['alpha', 'beta'])
    expect(mine[0]).toMatchObject({ shape: 'bundle', editable: true, rank: 400, path: join(USER_DSH(), 'alpha', 'SKILL.md') })
    expect(mine[1].shape).toBe('flat')
    expect(listing.issues.some(i => i.path.endsWith(join('broken', 'SKILL.md')))).toBe(true)
  })

  it('marks entries from non-writable roots read-only', () => {
    mkdirSync(custom, { recursive: true })
    writeFileSync(join(custom, 'shared.md'), makeSkill('shared'))
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: skills',
      `  name: '@deepseek-ai/dsh-skill-filesystem'`,
      '  config:',
      `    customSkillDirs: [${custom}]`,
      '',
    ].join('\n'))
    const shared = listSkills(ctx()).skills.find(s => s.name === 'shared')
    expect(shared).toMatchObject({ source: 'custom', editable: false })
    expect(findEditableSkill(ctx(), 'shared')).toBeUndefined()
  })
})

describe('write / rename / delete (writable root only)', () => {
  it('creates a bundle from full text and reads it back', () => {
    const entry = writeSkill(ctx(), null, makeSkill('creator', 'makes things'))
    expect(entry.editable).toBe(true)
    expect(existsSync(join(USER_DSH(), 'creator', 'SKILL.md'))).toBe(true)
    const text = readSkillFile(ctx(), 'creator')
    expect(text).toContain('name: creator')
    expect(parseSkillText(text).ok).toBe(true)
  })

  it('refuses to write text dsh would reject', () => {
    expect(() => writeSkill(ctx(), null, '---\nname: no-desc\n---\n')).toThrow()
    expect(() => writeSkill(ctx(), null, '---\nname: BAD\ndescription: x\n---\n')).toThrow()
  })

  it('renames when the frontmatter name changes', () => {
    writeSkill(ctx(), null, makeSkill('old-name'))
    const entry = writeSkill(ctx(), 'old-name', makeSkill('new-name'))
    expect(entry.dir).toBe(join(USER_DSH(), 'new-name'))
    expect(existsSync(join(USER_DSH(), 'old-name'))).toBe(false)
    expect(findEditableSkill(ctx(), 'old-name')).toBeUndefined()
    expect(findEditableSkill(ctx(), 'new-name')).toBeDefined()
  })

  it('refuses a rename onto an existing skill', () => {
    writeSkill(ctx(), null, makeSkill('collide-a'))
    writeSkill(ctx(), null, makeSkill('collide-b'))
    expect(() => writeSkill(ctx(), 'collide-a', makeSkill('collide-b'))).toThrow(/already exists/)
  })

  it('moves the bundle to the injected recycle bin on delete', async () => {
    writeSkill(ctx(), null, makeSkill('doomed'))
    expect(findEditableSkill(ctx(), 'doomed')).toBeDefined()
    await deleteSkill(ctx(), 'doomed')
    expect(existsSync(join(USER_DSH(), 'doomed'))).toBe(false)
    expect(existsSync(join(trashDir, 'doomed'))).toBe(true)
    expect(findEditableSkill(ctx(), 'doomed')).toBeUndefined()
  })

  it('deletes a flat file itself, not the root', async () => {
    skill('flat-doomed', makeSkill('flat-doomed'), true)
    await deleteSkill(ctx(), 'flat-doomed')
    expect(existsSync(join(USER_DSH(), 'flat-doomed.md'))).toBe(false)
    expect(existsSync(join(USER_DSH(), 'alpha'))).toBe(true)
  })
})
