/**
 * Per-profile grading: the same preset read against two profiles resolves a
 * different set of modules, and the verdict says so without ever calling a
 * preset the loader accepts broken.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { contextForEntry } from '../profile/appState.ts'
import { discoverPresets } from './roots.ts'
import { gradePresets, gradeTargets } from './rating.ts'
import { readCompositionValue } from './rows.ts'
import type { PresetRootInfo, PresetRow } from '../../../shared/types.ts'

let root: string
const home = (): string => join(root, 'home')
const userRoot = (): string => join(home(), '.agent-presets')
const installDsh = (): string => join(root, 'install', 'node_modules', '@deepseek-ai', 'dsh')
const ctx = (): ReturnType<typeof contextForEntry> =>
  contextForEntry({ id: 'a', name: 'dsh@a', execPath: installDsh(), version: 'a', home: home() })

/** An installed package directory (a manifest is what makes it resolvable). */
function mkPackage(parent: string, name: string): void {
  const dir = join(parent, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
}

/** A profile: its manifest, plus the packages it links itself. */
function mkProfile(name: string, own: string[] = []): void {
  const dir = join(home(), 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, dependencies: {}, dsh: { profile: { bundles: [] } },
  }))
  for (const pkg of own) mkPackage(dir, pkg)
}

/** A preset directory whose composition is the given rows. */
function mkPreset(id: string, rows: string): void {
  const dir = join(userRoot(), id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), rows)
}

/** The roster as discovery reads it, over the writable root only. */
function roster(): PresetRow[] {
  const rootInfo: PresetRootInfo = { path: userRoot(), trust: 'user', exists: true, writable: true }
  return discoverPresets([rootInfo])
}

/** One row of a preset composition. */
const row = (name: string, extra = ''): string => `- name: ${name}\n${extra}`

/** The dsh package itself: the ancestor holding a manifest is the install
 * anchor every package row resolves from. */
function mkInstall(): void {
  mkdirSync(installDsh(), { recursive: true })
  writeFileSync(join(installDsh(), 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pm-preset-rating-'))
  mkInstall()
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(home(), { recursive: true, force: true })
  mkInstall()
  mkProfile('alpha', ['@acme/tool-local'])
  mkProfile('beta')
  mkPackage(join(root, 'install'), '@deepseek-ai/dsh-tool-fs')
})

describe('gradePresets', () => {
  it('grades a preset that only names installed harness packages as ok everywhere', () => {
    mkPreset('standard', row("'@deepseek-ai/dsh-tool-fs'") + row('cordis:group'))
    expect(gradePresets(ctx(), roster(), ['alpha', 'beta'])).toEqual([
      { presetId: 'standard', profile: 'alpha', level: 'ok', checked: 2, skipped: 0, conditional: 0, missing: [] },
      { presetId: 'standard', profile: 'beta', level: 'ok', checked: 2, skipped: 0, conditional: 0, missing: [] },
    ])
  })

  it('reports a profile-only package as missing in the profile that does not link it', () => {
    mkPreset('local', "- id: local-tool\n  name: '@acme/tool-local'\n")
    const grades = gradePresets(ctx(), roster(), ['alpha', 'beta'])
    expect(grades.map(cell => [cell.profile, cell.level])).toEqual([['alpha', 'ok'], ['beta', 'incomplete']])
    expect(grades[0].missing).toEqual([])
    expect(grades[1].missing).toEqual([{ label: 'row "local-tool"', name: '@acme/tool-local' }])
  })

  it('resolves a preset-relative row against the preset directory', () => {
    mkPreset('relative', row('./helper.mjs'))
    writeFileSync(join(userRoot(), 'relative', 'helper.mjs'), 'export default 1\n')
    expect(gradePresets(ctx(), roster(), ['alpha'])[0].level).toBe('ok')

    mkPreset('relative-gone', row('./helper.mjs'))
    const byId = new Map(gradePresets(ctx(), roster(), ['alpha']).map(cell => [cell.presetId, cell]))
    expect(byId.get('relative-gone')?.missing).toEqual([{ label: 'row 1', name: './helper.mjs' }])
  })

  it('resolves a file: row, and refuses a malformed one', () => {
    const target = join(userRoot(), 'target.mjs')
    mkdirSync(userRoot(), { recursive: true })
    writeFileSync(target, 'export default 1\n')
    mkPreset('files', `${row(pathToFileURL(target).href)}${row('file:///%zz')}`)
    const byId = new Map(gradePresets(ctx(), roster(), ['alpha']).map(cell => [cell.presetId, cell]))
    expect(byId.get('files')?.missing).toEqual([{ label: 'row 2', name: 'file:///%zz' }])
  })

  it('does not anchor a relative `file:` row to the file beside it — the host does not either', () => {
    // A `file:` specifier is an ABSOLUTE URL, in every spelling. Measured against
    // the 0.2.0-rc.1 host with a real profile: every relative form (file:./x and
    // file:x, declared in the profile layer AND in a --patch overlay) makes it
    // refuse the row with "File URL path must be absolute", while an absolute
    // file URL in the same run imports fine. The file placed right beside the
    // declaration is never consulted, so "this row cannot mount here" is the
    // truth about the ROW, not a false alarm about the file — and the rating must
    // not helpfully add a base the host does not use, or it would grade a row the
    // host rejects as usable.
    mkPreset('beside', `${row('file:./pm-f4-unanchored.mjs')}${row('file:pm-f4-unanchored.mjs')}`)
    writeFileSync(join(userRoot(), 'beside', 'pm-f4-unanchored.mjs'), 'export default 1\n')
    const [cell] = gradePresets(ctx(), roster(), ['alpha'])
    expect(cell.level).toBe('incomplete')
    expect(cell.missing).toEqual([
      { label: 'row 1', name: 'file:./pm-f4-unanchored.mjs' },
      { label: 'row 2', name: 'file:pm-f4-unanchored.mjs' },
    ])
    // The `preset` spelling of the same intent is the one that works, and it is
    // anchored — that contrast is the whole point of the two row kinds.
    mkPreset('anchored', row('./pm-f4-anchored.mjs'))
    writeFileSync(join(userRoot(), 'anchored', 'pm-f4-anchored.mjs'), 'export default 1\n')
    expect(gradePresets(ctx(), roster(), ['alpha'])
      .find(cellGrade => cellGrade.presetId === 'anchored')?.level).toBe('ok')
  })

  it('calls an unreadable composition unusable, with the reason discovery gave', () => {
    mkPreset('broken', '[1, 2\n')
    const [cell] = gradePresets(ctx(), roster(), ['alpha'])
    expect(cell.level).toBe('unusable')
    expect(cell.reason).toContain('not valid YAML')
    expect(cell.checked).toBe(0)
  })

  it('never judges a row the host would not start', () => {
    mkPreset('off', "- id: off\n  name: '@acme/absent'\n  disabled: true\n")
    expect(gradePresets(ctx(), roster(), ['alpha'])).toEqual([
      { presetId: 'off', profile: 'alpha', level: 'ok', checked: 0, skipped: 1, conditional: 0, missing: [] },
    ])
  })

  it('leaves a !!js specifier undecided instead of missing', () => {
    mkPreset('gated', '- id: gated\n  name: !!js pickTool()\n')
    expect(gradePresets(ctx(), roster(), ['alpha'])).toEqual([
      { presetId: 'gated', profile: 'alpha', level: 'ok', checked: 0, skipped: 0, conditional: 1, missing: [] },
    ])
  })

  it('grades every preset against every profile in roster order', () => {
    mkPreset('one', row("'@deepseek-ai/dsh-tool-fs'"))
    mkPreset('two', row("'@acme/tool-local'"))
    const grades = gradePresets(ctx(), roster(), ['alpha', 'beta'])
    expect(grades.map(cell => `${cell.presetId}/${cell.profile}`)).toEqual([
      'one/alpha', 'one/beta', 'two/alpha', 'two/beta',
    ])
  })

  it('grades nothing when the dsh has no profiles', () => {
    mkPreset('standard', row("'@deepseek-ai/dsh-tool-fs'"))
    expect(gradePresets(ctx(), roster(), [])).toEqual([])
  })
})

// The declaration model produces its targets from a patch layer instead of a
// preset directory, so the base a `.`-relative row resolves against is the
// declaring FILE's directory and the rows are already parsed.
describe('gradeTargets', () => {
  it('judges already-parsed rows against the declaring directory', () => {
    mkInstall()
    mkProfile('alpha')
    const layerDir = join(root, 'bundle', 'presets')
    mkdirSync(layerDir, { recursive: true })
    writeFileSync(join(layerDir, 'local.mjs'), 'export default {}\n')

    const grades = gradeTargets(ctx(), [
      {
        id: 'declared',
        baseDir: layerDir,
        read: readCompositionValue([
          { id: 'local', name: './local.mjs' },
          { id: 'pkg', name: '@deepseek-ai/dsh-tool-fs' },
          { id: 'gone', name: '@acme/absent' },
        ]),
      },
    ], ['alpha'])
    expect(grades).toEqual([{
      presetId: 'declared',
      profile: 'alpha',
      level: 'incomplete',
      checked: 3,
      skipped: 0,
      conditional: 0,
      missing: [{ label: 'row "gone"', name: '@acme/absent' }],
    }])
  })

  it('reports an unusable target when its rows could not be read at all', () => {
    mkInstall()
    mkProfile('alpha')
    expect(gradeTargets(ctx(), [
      { id: 'broken', baseDir: root, read: { ok: false, problem: 'the declaration carries no `config` map' } },
    ], ['alpha'])).toEqual([{
      presetId: 'broken',
      profile: 'alpha',
      level: 'unusable',
      checked: 0,
      skipped: 0,
      conditional: 0,
      missing: [],
      reason: 'the declaration carries no `config` map',
    }])
  })
})
