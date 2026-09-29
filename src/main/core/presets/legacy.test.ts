/**
 * Legacy preset directories: what is still on disk under the retired root, and
 * the declaration each one migrates to.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextForEntry } from '../profile/appState.ts'
import { insertDeclaration } from './declaration.ts'
import { legacyPresets, migrationInput } from './legacy.ts'

let root: string
const home = (): string => join(root, 'home')
const userRoot = (): string => join(home(), '.agent-presets')
const ctx = (): ReturnType<typeof contextForEntry> =>
  contextForEntry({ id: 'a', name: 'dsh@a', execPath: '/fake/a', version: 'a', home: home() })

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-preset-legacy-')) })

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => { rmSync(root, { recursive: true, force: true }) })

/** A legacy preset directory with a composition and optional metadata. */
function mkDir(id: string, composition: string, meta?: string): string {
  const dir = join(userRoot(), id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), composition)
  if (meta !== undefined) writeFileSync(join(dir, 'preset.yml'), meta)
  return dir
}

describe('legacyPresets', () => {
  it('reports what the retired root holds, with its display text', () => {
    mkDir('liangshen', "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n", 'name: 梁神模式\ndescription: 试一下\norder: 5\n')
    expect(legacyPresets(ctx())).toEqual([
      {
        id: 'liangshen',
        dir: join(userRoot(), 'liangshen'),
        compositionPath: join(userRoot(), 'liangshen', 'agent.cordis.yml'),
        name: '梁神模式',
        description: '试一下',
        order: 5,
        read: { ok: true, text: "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n" },
      },
    ])
  })

  it('is empty when there is no root, and skips names no preset could claim', () => {
    expect(legacyPresets(ctx())).toEqual([])
    mkDir('mine', '- id: persona\n')
    mkdirSync(join(userRoot(), 'Not-An-Id'), { recursive: true })
    expect(legacyPresets(ctx()).map(p => p.id)).toEqual(['mine'])
  })

  it('keeps a directory whose composition is missing, with the reason', () => {
    mkdirSync(join(userRoot(), 'ghost'), { recursive: true })
    const [preset] = legacyPresets(ctx())
    expect(preset.id).toBe('ghost')
    expect(preset.read.ok).toBe(false)
    expect(preset.read.ok === false && preset.read.problem).toContain('is missing')
  })
})

describe('migrationInput', () => {
  it('carries id, display text and the composition verbatim under `plugins:`', () => {
    const composition = [
      '# a hand-written note',
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    prefix: hello',
      '    description: |-',
      '      keep me',
      "      and me, with 'quotes'",
      '- id: gate',
      "  name: '@deepseek-ai/dsh-agent-instructions'",
      "  disabled: !!js process.platform === 'win32'",
      '',
    ].join('\n')
    mkDir('mine', composition, 'name: Mine\ndescription: Only bash.\norder: 7\n')
    const [preset] = legacyPresets(ctx())
    const migrated = migrationInput(preset)
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    expect(migrated.input).toMatchObject({ id: 'mine', name: 'Mine', description: 'Only bash.', order: 7 })
    expect(migrated.input.pluginsBlock).toBe(
      ['plugins:', ...composition.trimEnd().split('\n').map(l => (l === '' ? '' : `  ${l}`))].join('\n'),
    )
    // The block survives a real insert byte for byte, `!!js` and the block scalar
    // included (a whole-config re-render would have destroyed both).
    const written = insertDeclaration('[]\n', migrated.input)
    expect(written).toContain("            disabled: !!js process.platform === 'win32'")
    expect(written).toContain('              description: |-')
    expect(written).toContain("                and me, with 'quotes'")
    expect(written).toContain('    - id: local-preset-mine')
  })

  it('refuses a directory whose composition cannot be read', () => {
    mkdirSync(join(userRoot(), 'ghost'), { recursive: true })
    const migrated = migrationInput(legacyPresets(ctx())[0])
    expect(migrated.ok).toBe(false)
    expect(migrated.ok === false && migrated.problem).toContain('is missing')
  })

  it('migrates a bare composition with no metadata', () => {
    mkDir('bare', "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n")
    const migrated = migrationInput(legacyPresets(ctx())[0])
    expect(migrated.ok && migrated.input).toEqual({
      id: 'bare',
      pluginsBlock: "plugins:\n  - id: persona\n    name: '@deepseek-ai/dsh-persona'",
    })
  })
})
