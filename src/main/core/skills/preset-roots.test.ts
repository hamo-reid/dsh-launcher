/**
 * The skill roots a PRESET contributes.
 *
 * A preset has no `skills` field in the host — it mounts skills through a
 * `skill-filesystem` row whose `customSkillDirs` points at a `!!js` expression the
 * launcher deliberately does not evaluate. So the launcher enumerates by the two
 * conventions the shipped presets establish, and these tests pin both the
 * conventions and the cases where neither applies.
 *
 * Fixtures are built per test; nothing here touches a real dsh home.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DECLARATION_PLUGIN, PRESET_PACKAGE } from '../../../shared/preset.ts'
import { listSkills, skillRoots } from './skills.ts'
import { presetSkillRoots } from './preset-roots.ts'
import type { DshContext } from '../profile/appState.ts'

let root: string
let home: string
let install: string

const ctx = (): DshContext => ({ execPath: install, home, version: '0.2.0-rc.1' })

/** A directory-model preset: a composition plus an optional `skills/` beside it. */
function dirPreset(id: string, withSkills: boolean): string {
  const dir = join(home, '.agent-presets', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n')
  if (withSkills) {
    const skills = join(dir, 'skills')
    mkdirSync(join(skills, 'helper'), { recursive: true })
    writeFileSync(join(skills, 'helper', 'SKILL.md'), '---\nname: helper\ndescription: helps\n---\nbody\n')
  }
  return dir
}

/** Install a package under the anchor the way pnpm does: a real directory. */
function providePackage(name: string, files: Record<string, string>): string {
  const dir = join(install, 'node_modules', name)
  for (const [rel, text] of Object.entries(files)) {
    const file = join(dir, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text)
  }
  mkdirSync(join(install, 'node_modules', '.bin'), { recursive: true })
  return dir
}

/** A profile dir, which is what makes it a profile at all. */
function profile(name: string, patch = ''): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, private: true }))
  if (patch !== '') writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  return dir
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pm-preset-skills-'))
  home = join(root, 'home')
  install = join(root, 'install')
  mkdirSync(home, { recursive: true })
  mkdirSync(install, { recursive: true })
  writeFileSync(join(install, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' }))
  // Pin the agents root away from the real `~/.agents`.
  process.env.DSH_AGENTS_HOME = join(root, 'agents')
  mkdirSync(join(root, 'agents'), { recursive: true })
})

afterAll(() => {
  delete process.env.DSH_AGENTS_HOME
  rmSync(root, { recursive: true, force: true })
})

describe('preset-contributed skill roots', () => {
  it('finds a directory-model preset\'s skills directory', () => {
    rmSync(join(home, '.agent-presets'), { recursive: true, force: true })
    const dir = dirPreset('cordis', true)
    profile('work', '- insert:\n    - id: pack\n      name: \'@deepseek-ai/dsh-agent-presets\'\n')
    const found = presetSkillRoots(ctx(), 'work')
    expect(found).toEqual([{ path: join(dir, 'skills'), owner: 'cordis' }])
  })

  it('skips a directory-model preset that ships no skills', () => {
    rmSync(join(home, '.agent-presets'), { recursive: true, force: true })
    dirPreset('bare', false)
    profile('work', '- insert:\n    - id: pack\n      name: \'@deepseek-ai/dsh-agent-presets\'\n')
    expect(presetSkillRoots(ctx(), 'work')).toEqual([])
  })

  it('resolves the declaration model through its own resolution chain', () => {
    rmSync(join(home, '.agent-presets'), { recursive: true, force: true })
    const pkg = providePackage(DECLARATION_PLUGIN, {
      'package.json': JSON.stringify({ name: DECLARATION_PLUGIN, version: '0.2.0-rc.1' }),
      'skills/from-preset/SKILL.md': '---\nname: from-preset\ndescription: shipped\n---\nbody\n',
    })
    profile('work', `- insert:\n    - id: decl\n      name: '${DECLARATION_PLUGIN}'\n`)
    expect(presetSkillRoots(ctx(), 'work')).toEqual([{ path: join(pkg, 'skills'), owner: DECLARATION_PLUGIN }])
    // …and it becomes a scanned root the catalog reads, not just a report line.
    const roots = skillRoots(ctx(), { profile: 'work' })
    expect(roots.filter(r => r.source === 'preset').map(r => r.root)).toEqual([`preset:${DECLARATION_PLUGIN}`])
    expect(listSkills(ctx(), { profile: 'work' }).skills.map(s => s.name)).toContain('from-preset')
  })

  it('reports nothing without a profile', () => {
    rmSync(join(home, '.agent-presets'), { recursive: true, force: true })
    dirPreset('cordis', true)
    profile('work', '- insert:\n    - id: pack\n      name: \'@deepseek-ai/dsh-agent-presets\'\n')
    // The directory roster is per dsh, but which presets compose is per profile —
    // so the panel that has no profile selected gets the machine-level answer,
    // not a guess about a preset layer.
    expect(presetSkillRoots(ctx(), '')).toEqual([])
    expect(skillRoots(ctx()).some(r => r.source === 'preset')).toBe(false)
    expect(skillRoots(ctx(), {}).some(r => r.source === 'preset')).toBe(false)
  })

  it('reports nothing for a profile that mounts no preset model', () => {
    rmSync(join(home, '.agent-presets'), { recursive: true, force: true })
    profile('plain')
    expect(presetSkillRoots(ctx(), 'plain')).toEqual([])
  })

  it('places a preset root at custom rank and never writable', () => {
    rmSync(join(home, '.agent-presets'), { recursive: true, force: true })
    providePackage(DECLARATION_PLUGIN, {
      'package.json': JSON.stringify({ name: DECLARATION_PLUGIN, version: '0.2.0-rc.1' }),
      'skills/x/SKILL.md': '---\nname: x\ndescription: y\n---\nz\n',
    })
    profile('work', `- insert:\n    - id: decl\n      name: '${DECLARATION_PLUGIN}'\n`)
    const preset = skillRoots(ctx(), { profile: 'work' }).find(r => r.source === 'preset')
    // The host registers a preset's dirs through `customSkillDirs`, so they are
    // custom roots to it — same rank, and not launcher-writable.
    expect(preset).toMatchObject({ rank: 300, writable: false })
  })

  it('does not resolve a preset package that is not installed', () => {
    rmSync(join(home, '.agent-presets'), { recursive: true, force: true })
    rmSync(join(install, 'node_modules', DECLARATION_PLUGIN), { recursive: true, force: true })
    profile('work', `- insert:\n    - id: decl\n      name: '${DECLARATION_PLUGIN}'\n`)
    // The row is declared but the package is gone — the same state the launcher's
    // other tracks report as MISSING rather than inventing a root.
    expect(presetSkillRoots(ctx(), 'work')).toEqual([])
  })

  it('ignores the retired directory model when the profile composes declarations', () => {
    // A dsh that no longer reads `.agent-presets` still has the directories on
    // disk; they must not contribute roots.
    rmSync(join(home, '.agent-presets'), { recursive: true, force: true })
    dirPreset('legacy', true)
    profile('work', `- insert:\n    - id: decl\n      name: '${DECLARATION_PLUGIN}'\n`)
    expect(presetSkillRoots(ctx(), 'work')).toEqual([])
    expect(PRESET_PACKAGE).toBe('@deepseek-ai/dsh-agent-presets')
  })
})