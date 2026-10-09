/**
 * Behavior tests for the skills track: root resolution (config row + defaults),
 * dsh-mirroring frontmatter acceptance, listing with issues, and write / rename
 * / recycle-bin delete confined to the writable user-dsh root.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextForEntry } from '../profile/appState.ts'
import { AppError } from '../shared/errors.ts'
import {
  deleteSkill, findEditableSkill, importSkillZip, installZipSkills, listSkills, parseSkillText, readSkillFile, renderSkillFile,
  scaffoldSkill, setSkillTrash, skillRoots, writeSkill, zipEntryUnsafe, zipImportProblem,
} from './skills.ts'
import type { DshContext } from '../profile/appState.ts'

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
// not leak the roots it declares into the next. Skill fixtures are NOT reset
// here — later tests in this file build on what earlier ones wrote.
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

  it('reports a !!js customSkillDirs as a runtime root instead of resolving it', () => {
    // The shipped presets write exactly this form. A `!!js` scalar parses to a
    // sentinel-prefixed STRING, so it survives a `typeof` filter — resolving one
    // used to produce a path built from JavaScript source (and `resolve()` even
    // normalised the slashes inside the expression).
    const expression = "process.getBuiltinModule('node:path').join('/somewhere/pkg', 'skills')"
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: skills',
      `  name: '@deepseek-ai/dsh-skill-filesystem'`,
      '  config:',
      '    customSkillDirs:',
      `      - !!js "${expression}"`,
      '',
    ].join('\n'))
    const roots = skillRoots(ctx())
    expect(roots.map(r => r.root)).toEqual(['runtime:0', 'user-dsh', 'user-agents'])
    const runtime = roots[0]
    expect(runtime).toMatchObject({ source: 'custom', rank: 300, writable: false, exists: false, runtime: true })
    // The expression survives verbatim — no sentinel byte, no cwd prefix, and
    // the slashes inside it untouched (this is what `resolve()` used to mangle).
    expect(runtime?.path).toBe(expression)
    expect(runtime?.path).not.toContain('\u0000')
    expect(runtime?.path).not.toContain(tmpdir())
  })

  it('keeps plain and !!js customSkillDirs apart, in order', () => {
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: skills',
      `  name: '@deepseek-ai/dsh-skill-filesystem'`,
      '  config:',
      '    customSkillDirs:',
      `      - ${custom}`,
      `      - !!js "process.env.SOMEWHERE"`,
      '',
    ].join('\n'))
    const roots = skillRoots(ctx())
    expect(roots.map(r => [r.root, r.runtime === true])).toEqual([
      ['custom:0', false],
      ['runtime:0', true],
      ['user-dsh', false],
      ['user-agents', false],
    ])
    expect(roots[0].path).toBe(custom)
  })

  it('never scans a runtime root', () => {
    // A real user-dsh skill next to a runtime declaration: the catalog holds the
    // skill and nothing derived from the expression. Fixtures are removed again
    // because later describes assert exact catalogs.
    const greeter = join(USER_DSH(), 'greeter')
    const phantomRoot = join(custom, 'skills')
    try {
      skill('greeter', makeSkill('greeter'))
      writeFileSync(join(home, 'cordis.patch.yml'), [
        '- id: skills',
        `  name: '@deepseek-ai/dsh-skill-filesystem'`,
        '  config:',
        '    customSkillDirs:',
        `      - !!js "process.getBuiltinModule('node:path').join('${custom}', 'skills')"`,
        '',
      ].join('\n'))
      // The path the expression names really exists, so a scanner that ignored
      // the flag would find it — the flag, not `exists`, is what keeps it out.
      mkdirSync(phantomRoot, { recursive: true })
      writeFileSync(join(phantomRoot, 'phantom.md'), makeSkill('phantom'))
      const listing = listSkills(ctx())
      expect(listing.skills.map(s => s.name)).toEqual(['greeter'])
      expect(listing.roots.some(r => r.runtime === true && r.exists)).toBe(false)
    } finally {
      rmSync(greeter, { recursive: true, force: true })
      rmSync(custom, { recursive: true, force: true })
    }
  })

  it('keeps a runtime root when the default roots are switched off', () => {
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: skills',
      `  name: '@deepseek-ai/dsh-skill-filesystem'`,
      '  config:',
      '    includeDefaultRoots: false',
      '    customSkillDirs:',
      `      - !!js "process.env.SOMEWHERE"`,
      '',
    ].join('\n'))
    // `customSkillDirs` survives `includeDefaultRoots: false` because dsh adds it
    // AROUND the default roots, not inside them; a `!!js` entry is still a
    // custom dir, so it must survive on the same terms.
    expect(skillRoots(ctx()).map(r => r.root)).toEqual(['runtime:0'])
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

  it('reports an unreadable skill file as an issue instead of failing the catalog', () => {
    // `scanRoot` walks a whole root inside one call, so a file that cannot be
    // read — here a directory where the entry claims a file — used to throw out
    // of `listSkills` and lose every OTHER skill in the root with it. A file dsh
    // also cannot read is a file dsh does not load, which is what an issue is.
    const unreadable = join(USER_DSH(), 'unreadable', 'SKILL.md')
    const sibling = join(USER_DSH(), 'sibling')
    try {
      skill('sibling', makeSkill('sibling'))
      mkdirSync(unreadable, { recursive: true })
      const listing = listSkills(ctx())
      expect(listing.skills.map(s => s.name)).toContain('sibling')
      const issue = listing.issues.find(i => i.path === unreadable)
      expect(issue?.reason).toContain('cannot be read')
    } finally {
      rmSync(join(USER_DSH(), 'unreadable'), { recursive: true, force: true })
      rmSync(sibling, { recursive: true, force: true })
    }
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

  it('refuses a fresh create over a name the writable root already holds', () => {
    // A create passes `previousName: null` — the editor has nothing to read yet, so
    // it cannot know the name is taken. Without this guard the new text silently
    // replaced the existing SKILL.md and the caller saw a plain success.
    writeSkill(ctx(), null, makeSkill('taken-bundle', 'the original'))
    expect(() => writeSkill(ctx(), null, makeSkill('taken-bundle', 'the impostor')))
      .toThrow(/ext\.skillExists/)
    expect(readSkillFile(ctx(), 'taken-bundle')).toContain('the original')
  })

  it('refuses a fresh create beside a flat file of the same name', () => {
    // A bundle next to `<name>.md` is two skills under one name, and dsh takes
    // whichever it scans first.
    skill('taken-flat', makeSkill('taken-flat'), true)
    expect(() => writeSkill(ctx(), null, makeSkill('taken-flat'))).toThrow(/ext\.skillExists/)
    expect(existsSync(join(USER_DSH(), 'taken-flat'))).toBe(false)
    expect(existsSync(join(USER_DSH(), 'taken-flat.md'))).toBe(true)
  })

  it('reports a name outside the writable root as read-only, not as an internal error', async () => {
    // The refusal is a business answer (`ext.skillReadOnly`, localized) rather than
    // an `internal` one: the name can be perfectly real and simply live in a
    // read-only root — or, as here, have been moved out of the writable one.
    skill('moved-out', makeSkill('moved-out'))
    renameSync(join(USER_DSH(), 'moved-out'), join(root, 'elsewhere-moved-out'))
    expect(() => readSkillFile(ctx(), 'moved-out')).toThrow(/ext\.skillReadOnly/)
    expect(() => writeSkill(ctx(), 'moved-out', makeSkill('moved-out'))).toThrow(/ext\.skillReadOnly/)
    await expect(deleteSkill(ctx(), 'moved-out')).rejects.toThrow(/ext\.skillReadOnly/)
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

  it('saving a flat skill in place upgrades it to a bundle and removes the flat file', () => {
    skill('flat-edit', makeSkill('flat-edit'), true)
    const entry = writeSkill(ctx(), 'flat-edit', makeSkill('flat-edit', 'edited in place'))
    expect(entry.shape).toBe('bundle')
    expect(existsSync(join(USER_DSH(), 'flat-edit.md'))).toBe(false)
    expect(existsSync(join(USER_DSH(), 'flat-edit', 'SKILL.md'))).toBe(true)
    // One skill, not two: the flat file no longer shadows the bundle.
    expect(listSkills(ctx()).skills.filter(s => s.name === 'flat-edit')).toHaveLength(1)
    expect(readSkillFile(ctx(), 'flat-edit')).toContain('edited in place')
  })
})

describe('zip import', () => {
  /** Build a zip file from virtual entries and return its path. */
  function writeZip(name: string, files: Record<string, string>): string {
    const arc = new AdmZip()
    for (const [path, content] of Object.entries(files)) arc.addFile(path, Buffer.from(content, 'utf8'))
    const file = join(root, name)
    arc.writeZip(file)
    return file
  }

  /** The code an import throws, or a marker when it threw something else. */
  function codeOf(zipPath: string, probe?: (name: string) => boolean): string {
    try {
      if (probe === undefined) importSkillZip(ctx(), zipPath)
      else installZipSkills(USER_DSH(), zipPath, probe)
      return '(no throw)'
    } catch (error) {
      return error instanceof AppError ? error.code : `not-app:${String(error)}`
    }
  }

  it('installs a <dir>/SKILL.md bundle with its resources under the frontmatter name', () => {
    const zip = writeZip('single.zip', {
      'pdf-tools/SKILL.md': makeSkill('pdf-tools'),
      'pdf-tools/scripts/run.ps1': 'Write-Output hi',
    })
    const installed = importSkillZip(ctx(), zip)
    expect(installed).toHaveLength(1)
    expect(installed[0]).toMatchObject({ name: 'pdf-tools', shape: 'bundle', editable: true, source: 'user-dsh' })
    expect(existsSync(join(USER_DSH(), 'pdf-tools', 'scripts', 'run.ps1'))).toBe(true)
    expect(findEditableSkill(ctx(), 'pdf-tools')?.entry.path).toBe(join(USER_DSH(), 'pdf-tools', 'SKILL.md'))
  })

  it('treats a root-level SKILL.md as one whole-archive bundle', () => {
    const zip = writeZip('root.zip', { 'SKILL.md': makeSkill('root-skill'), 'NOTES.md': 'resources ride along' })
    const installed = importSkillZip(ctx(), zip)
    expect(installed).toHaveLength(1)
    expect(existsSync(join(USER_DSH(), 'root-skill', 'NOTES.md'))).toBe(true)
  })

  it('installs every skill of a multi-skill zip, through a wrapper dir too', () => {
    const zip = writeZip('pack.zip', {
      'repo-main/one/SKILL.md': makeSkill('zip-one'),
      'repo-main/two/SKILL.md': makeSkill('zip-two'),
    })
    const installed = importSkillZip(ctx(), zip)
    expect(installed.map(e => e.name).sort()).toEqual(['zip-one', 'zip-two'])
    expect(existsSync(join(USER_DSH(), 'zip-one', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(USER_DSH(), 'zip-two', 'SKILL.md'))).toBe(true)
  })

  it('rejects a zip with no SKILL.md', () => {
    const zip = writeZip('empty.zip', { 'readme.txt': 'nothing here' })
    expect(codeOf(zip)).toBe('ext.skillZipNoSkill')
  })

  it('guards zip-slip entry names (unit) without false-positive on sanitized ones', () => {
    // adm-zip normalizes hostile names when WRITING, so a raw `../` entry can
    // only reach the guard from a third-party archive on READ — the guard is
    // therefore pinned by direct unit tests, not by a crafted archive.
    expect(zipEntryUnsafe('../evil.txt')).toBe(true)
    expect(zipEntryUnsafe('a/../../evil.txt')).toBe(true)
    expect(zipEntryUnsafe('..\\evil.txt')).toBe(true)
    expect(zipEntryUnsafe('/abs.txt')).toBe(true)
    expect(zipEntryUnsafe('C:/evil.txt')).toBe(true)
    expect(zipEntryUnsafe('ok/SKILL.md')).toBe(false)
    expect(zipEntryUnsafe('evil.txt')).toBe(false)
    // A name adm-zip sanitized on write reads back as `evil.txt` — the import
    // must proceed normally instead of failing on a false positive.
    const zip = writeZip('slip.zip', { 'ok/SKILL.md': makeSkill('ok'), '../evil.txt': 'nope' })
    const installed = importSkillZip(ctx(), zip)
    expect(installed.map(entry => entry.name)).toEqual(['ok'])
  })

  it('refuses a name collision and installs nothing', () => {
    writeSkill(ctx(), null, makeSkill('taken'))
    const before = existsSync(join(USER_DSH(), 'taken'))
    const zip = writeZip('collide.zip', { 'taken/SKILL.md': makeSkill('taken') })
    expect(codeOf(zip)).toBe('ext.skillExists')
    expect(existsSync(join(USER_DSH(), 'taken'))).toBe(before)
  })

  it('refuses a name that appeared between the two passes, and lands nothing', () => {
    // Pass 1's probe is a courtesy to the caller; the pre-copy re-check is what
    // holds, because a name can appear in between (another import, or a person
    // creating the skill while the dialog was open). A probe that answers "free"
    // once and "taken" the second time is exactly that window.
    const zip = writeZip('race.zip', { 'race/SKILL.md': makeSkill('race-skill') })
    let probes = 0
    const code = codeOf(zip, () => { probes += 1; return probes > 1 })
    expect(code).toBe('ext.skillExists')
    expect(probes).toBe(2)
    // All-or-nothing still holds: the refused copy never landed.
    expect(existsSync(join(USER_DSH(), 'race-skill'))).toBe(false)
  })

  it('lets the filesystem refuse a destination that exists, not just the probe', () => {
    // The re-check and `errorOnExist` are two halves of one guarantee: even a probe
    // that always says "free" must not overwrite an existing directory.
    const zip = writeZip('occupied.zip', { 'occupied/SKILL.md': makeSkill('occupied-skill') })
    mkdirSync(join(USER_DSH(), 'occupied-skill'), { recursive: true })
    writeFileSync(join(USER_DSH(), 'occupied-skill', 'SKILL.md'), makeSkill('occupied-skill', 'the original'))
    expect(codeOf(zip, () => false)).not.toBe('(no throw)')
    expect(readFileSync(join(USER_DSH(), 'occupied-skill', 'SKILL.md'), 'utf8')).toContain('the original')
  })

  it('is all-or-nothing: one bad skill fails the whole zip', () => {
    const zip = writeZip('mixed.zip', {
      'good/SKILL.md': makeSkill('zip-good'),
      'bad/SKILL.md': '---\nname: zip-bad\n---\n', // no description
    })
    expect(codeOf(zip)).toBe('ext.badSkill')
    expect(existsSync(join(USER_DSH(), 'zip-good'))).toBe(false)
    expect(existsSync(join(USER_DSH(), 'zip-bad'))).toBe(false)
  })

  it('rejects duplicate skill names within one zip', () => {
    const zip = writeZip('dupe.zip', {
      'a/SKILL.md': makeSkill('zip-dupe'),
      'b/SKILL.md': makeSkill('zip-dupe'),
    })
    expect(codeOf(zip)).toBe('ext.skillExists')
  })
})

describe('zip import pre-flight (explicit paths, e.g. drag & drop)', () => {
  it('rejects a missing path and a directory as missing', () => {
    expect(zipImportProblem(join(root, 'no-such.zip'))).toEqual(
      { code: 'ext.skillZipMissing', detail: join(root, 'no-such.zip') },
    )
    mkdirSync(join(root, 'adir.zip'), { recursive: true })
    expect(zipImportProblem(join(root, 'adir.zip'))?.code).toBe('ext.skillZipMissing')
  })

  it('rejects a non-zip extension without touching the archive', () => {
    const txt = join(root, 'notes.txt')
    writeFileSync(txt, 'just text')
    expect(zipImportProblem(txt)?.code).toBe('ext.skillZipNotZip')
  })

  it('passes a real zip through to the installer', () => {
    const arc = new AdmZip()
    arc.addFile('ok/SKILL.md', Buffer.from(makeSkill('preflight-ok'), 'utf8'))
    const file = join(root, 'ok.zip')
    arc.writeZip(file)
    expect(zipImportProblem(file)).toBeNull()
  })

  it('reports garbage bytes under a .zip name as unreadable, not internal', () => {
    const file = join(root, 'garbage.zip')
    writeFileSync(file, 'definitely not a zip archive')
    let code = ''
    try {
      installZipSkills(join(root, 'target'), file, () => false)
    } catch (error) {
      code = error instanceof AppError ? error.code : `unexpected: ${String(error)}`
    }
    expect(code).toBe('ext.skillZipBad')
  })
})
