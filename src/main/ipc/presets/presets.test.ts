/**
 * The preset IPC boundary: the listing a page renders for ONE profile, and the
 * guard on every write — a profile name or preset id that could escape its
 * directory, a metadata payload of the wrong shape, and an unknown preset all
 * refused before any filesystem work.
 *
 * Both models are exercised end to end here, because the boundary is where the
 * two must be indistinguishable to the page.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../core/settings/settings.ts'
import { updateDshState } from '../../core/profile/appState.ts'
import { setPresetTrash } from '../../core/presets/authoring.ts'
import { registerPresetsIpc } from './presets.ts'
import type { IpcResult, PresetListing } from '../../../shared/types.ts'

/** Every registered channel, plus the shell calls the write handlers make, and
 * three call counters: how often the layer stack was composed, how often the
 * roster was graded, and how many module probes a call spent. They are here to
 * pin what a PRESET action must NOT do — composition and grading are the
 * expensive reads, and grading costs one probe per row. */
const { channels, openPath, openExternal, counters } = vi.hoisted(() => ({
  channels: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  openPath: vi.fn(async () => ''),
  openExternal: vi.fn(async () => undefined),
  counters: { compose: 0, grade: 0, resolve: 0 },
}))

vi.mock('../../core/store/combo.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/store/combo.ts')>()
  return {
    ...actual,
    composeLayerTexts: (...args: Parameters<typeof actual.composeLayerTexts>) => {
      counters.compose += 1
      return actual.composeLayerTexts(...args)
    },
  }
})

vi.mock('../../core/presets/rating.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/presets/rating.ts')>()
  return {
    ...actual,
    gradeTargets: (...args: Parameters<typeof actual.gradeTargets>) => {
      counters.grade += 1
      return actual.gradeTargets(...args)
    },
  }
})

vi.mock('../../core/store/module-resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/store/module-resolve.ts')>()
  return {
    ...actual,
    resolveModule: (...args: Parameters<typeof actual.resolveModule>) => {
      counters.resolve += 1
      return actual.resolveModule(...args)
    },
  }
})

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  dialog: {},
  shell: { openPath, openExternal },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void => {
      channels.set(channel, fn)
    },
  },
}))

let root: string
let trashed: string[]
const home = (): string => join(root, 'home')
const userRoot = (): string => join(home(), '.agent-presets')
const homePatch = (): string => join(home(), 'cordis.patch.yml')
const profileDir = (name: string): string => join(home(), 'profiles', name)
const patchPath = (name: string): string => join(profileDir(name), 'cordis.patch.yml')
const bundleDir = (): string => join(profileDir('decl'), 'node_modules', '@deepseek-ai', 'dsh-web-app')

/** Invoke one registered handler. `handle` wraps every body in an async
 * function, so a handler call is always a promise. */
async function call<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  const fn = channels.get(channel)
  if (fn === undefined) throw new Error(`${channel} was not registered`)
  return await fn({}, ...args) as IpcResult<T>
}

/** Invoke one handler and unwrap its value, failing the test on a refusal. */
async function ok<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await call<T>(channel, ...args)
  if (!result.ok) throw new Error(`${channel} refused: ${result.code}`)
  return result.value
}

/** A preset directory whose composition names one built-in row, which resolves
 * with or without an install on this machine. */
function mkPreset(id: string): void {
  const dir = join(userRoot(), id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), '- id: persona\n  name: cordis:group\n')
}

/** A profile: a directory carrying a manifest, which is what dsh launches. */
function mkProfile(name: string, bundles: string[] = []): void {
  const dir = profileDir(name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, dependencies: {}, dsh: { profile: { bundles } },
  }))
}

/** The one declaration `decl`'s own patch layer carries. */
const DECLARED_ROW = [
  '    - id: local-preset-mine',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: mine',
  '        name: My mode',
  '        description: Only bash.',
  '        order: 3',
  '        plugins:',
  '          - id: persona',
  "            name: '@deepseek-ai/dsh-persona'",
  '          - id: gate',
  "            name: '@deepseek-ai/dsh-agent-instructions'",
  "            disabled: !!js process.platform === 'win32'",
]

/** `decl`'s own patch layer: a declaration, plus whatever else a test adds. */
function mkDeclaringProfile(...extra: string[]): void {
  writeFileSync(patchPath('decl'), ['- insert:', ...DECLARED_ROW, ...extra, ''].join('\n'))
}

/** A declaration in the machine-level home patch: the same file for every
 * profile of this dsh, which is why this page may not write to it. */
const HOME_DECLARED_ROW = [
  '    - id: local-preset-machine',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: machine',
  '        plugins:',
  '          - id: persona',
  "            name: '@deepseek-ai/dsh-persona'",
]

/** Put {@link HOME_DECLARED_ROW} into the home patch, beside nothing else. */
function mkHomeDeclaringProfile(): void {
  writeFileSync(homePatch(), ['- insert:', ...HOME_DECLARED_ROW, ''].join('\n'))
}

/** A bundle that declares one preset in its SECOND patch file — the shape
 * 0.2.0-rc.1's `dsh-web-app` ships, which is also what proves a bundle's whole
 * declared patch list is read. */
function mkPresetBundle(): void {
  const dir = bundleDir()
  mkdirSync(join(dir, 'presets'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dsh: { bundle: { patch: ['./cordis.patch.yml', './presets/standard.patch.yml'] } },
  }))
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: agent-preset-registry',
    "      name: '@deepseek-ai/dsh-agent-preset-registry'",
    '      config:',
    '        default: standard',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'presets', 'standard.patch.yml'), [
    '- insert:',
    '    - id: preset-standard',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: standard',
    '        order: 1',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '',
  ].join('\n'))
}

/** A profile whose composition mounts the retired presets package, which is what
 * makes it a DIRECTORY-model profile. */
function mkDirectoryProfile(name: string): void {
  mkProfile(name)
  writeFileSync(patchPath(name), [
    '- insert:',
    '    - id: agent-presets',
    "      name: '@deepseek-ai/dsh-agent-presets'",
    '      config:',
    '        default: standard',
    '',
  ].join('\n'))
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-preset-ipc-'))
  await openDatabase(join(root, 'app.sqlite'))
  mkdirSync(home(), { recursive: true })
  updateDshState(() => [{ id: 'a', name: 'dsh@a', execPath: '/fake/a', version: 'a', home: home() }])
  registerPresetsIpc()
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(userRoot(), { recursive: true, force: true })
  rmSync(homePatch(), { force: true })
  trashed = []
  setPresetTrash(async (target) => { trashed.push(target) })
  openPath.mockClear()
  openExternal.mockClear()
  counters.compose = 0
  counters.grade = 0
  counters.resolve = 0
  mkPreset('mine')
  mkDirectoryProfile('alpha')
  mkDirectoryProfile('beta')
  rmSync(profileDir('decl'), { recursive: true, force: true })
  mkProfile('decl')
})

afterEach(() => { setPresetTrash(null) })

// ── the directory model ─────────────────────────────────────────────────────

describe('preset:list (directory model)', () => {
  it('returns the profile, its places, the roster and that profile\'s grades', async () => {
    const listing = await ok<PresetListing>('preset:list', 'a', 'alpha')
    expect(listing).toMatchObject({ profile: 'alpha', model: 'directory', legacy: [], warnings: [] })
    expect(listing.places).toEqual([
      { source: 'user-dir', path: userRoot(), exists: true, writable: true },
    ])
    expect(listing.presets).toEqual([
      {
        id: 'mine',
        trust: 'user',
        source: 'user-dir',
        editable: true,
        location: join(userRoot(), 'mine'),
        locationKind: 'dir',
      },
    ])
    expect(listing.grades.map(cell => `${cell.presetId}/${cell.profile}:${cell.level}`)).toEqual(['mine/alpha:ok'])
  })

  it('grades against the requested profile only', async () => {
    expect((await ok<PresetListing>('preset:list', 'a', 'beta')).grades.map(c => c.profile)).toEqual(['beta'])
  })

  it('refuses an unknown dsh and a profile name that could escape the profiles tree', async () => {
    expect(await call('preset:list', 'nope', 'alpha')).toMatchObject({ ok: false, code: 'dsh.notFound' })
    expect(await call('preset:list', 'a', '../escape')).toMatchObject({ ok: false, code: 'name.invalid' })
    expect(await call('preset:list', 'a', 'no-such-profile')).toMatchObject({ ok: false, code: 'internal' })
  })
})

describe('the directory-model writes', () => {
  it('stores the three editable fields in preset.yml', async () => {
    expect(await ok<boolean>('preset:saveMeta', 'a', 'alpha', 'mine', {
      name: '我的模式', description: '一句话', order: 3,
    })).toBe(true)
    expect(readFileSync(join(userRoot(), 'mine', 'preset.yml'), 'utf8'))
      .toBe('name: 我的模式\ndescription: 一句话\norder: 3\n')
  })

  it('refuses an id that could escape the root, and a payload of the wrong shape', async () => {
    expect(await call('preset:saveMeta', 'a', 'alpha', '../escape', { name: 'x', description: '', order: null }))
      .toMatchObject({ ok: false, code: 'preset.badId' })
    expect(existsSync(join(root, 'escape'))).toBe(false)
    expect(await call('preset:saveMeta', 'a', 'alpha', 'mine', { name: 1, description: '', order: null }))
      .toMatchObject({ ok: false, code: 'name.invalid' })
    expect(await call('preset:saveMeta', 'a', 'alpha', 'nope', { name: 'x', description: '', order: null }))
      .toMatchObject({ ok: false, code: 'preset.notFound' })
  })

  it('copies a preset into the writable root under a new id', async () => {
    expect(await ok<boolean>('preset:copy', 'a', 'alpha', 'mine', 'copy', '复制品')).toBe(true)
    expect(existsSync(join(userRoot(), 'copy', 'agent.cordis.yml'))).toBe(true)
    expect(readFileSync(join(userRoot(), 'copy', 'preset.yml'), 'utf8')).toBe('name: 复制品\n')
    expect(await call('preset:copy', 'a', 'alpha', 'mine', 'mine', 'x'))
      .toMatchObject({ ok: false, code: 'preset.exists' })
  })

  it('moves the preset directory to the recycle bin', async () => {
    expect(await ok<boolean>('preset:delete', 'a', 'alpha', 'mine')).toBe(true)
    expect(trashed).toEqual([join(userRoot(), 'mine')])
    expect(await call('preset:delete', 'a', 'alpha', 'nope')).toMatchObject({ ok: false, code: 'preset.notFound' })
  })

  it('reveals the directory and opens it through the editor protocol', async () => {
    expect(await ok<boolean>('preset:reveal', 'a', 'alpha', 'mine')).toBe(true)
    expect(openPath).toHaveBeenCalledWith(join(userRoot(), 'mine'))
    expect(await ok<boolean>('preset:openEditor', 'a', 'alpha', 'mine')).toBe(true)
    expect(openExternal).toHaveBeenCalledWith(`vscode://file/${join(userRoot(), 'mine').replace(/\\/g, '/')}`)
  })

  it('refuses to reveal an unknown preset', async () => {
    expect(await call('preset:reveal', 'a', 'alpha', 'nope')).toMatchObject({ ok: false, code: 'preset.notFound' })
    expect(openPath).not.toHaveBeenCalled()
  })
})

// ── the declaration model ───────────────────────────────────────────────────

describe('preset:list (declaration model)', () => {
  beforeEach(() => {
    // The retired root starts empty here: what it holds is a topic of its own,
    // and a stray directory would show up as legacy in every assertion below.
    rmSync(userRoot(), { recursive: true, force: true })
    mkProfile('decl', ['@deepseek-ai/dsh-web-app'])
    mkPresetBundle()
    mkDeclaringProfile()
  })

  it('reads the roster from the composed layers, with each row\'s provenance', async () => {
    const listing = await ok<PresetListing>('preset:list', 'a', 'decl')
    expect(listing.model).toBe('declaration')
    expect(listing.warnings).toEqual([])
    expect(listing.presets).toEqual([
      {
        // The bundle's declaration sorts first on `order`.
        id: 'standard', trust: 'system', source: 'bundle', bundle: '@deepseek-ai/dsh-web-app',
        order: 1, editable: false,
        location: join(bundleDir(), 'presets', 'standard.patch.yml'), locationKind: 'file',
        // The loader row that carries it: the host loads THAT row, not the id.
        rowId: 'preset-standard',
      },
      {
        id: 'mine', trust: 'user', source: 'profile', name: 'My mode', description: 'Only bash.',
        order: 3, editable: true, location: patchPath('decl'), locationKind: 'file',
        rowId: 'local-preset-mine',
      },
    ])
    // The bundle's SECOND patch file is where the declaration lives, so a
    // single-file bundle read would have listed nothing at all — and each patch
    // file is its own place, since dsh applies them in order.
    expect(listing.places.map(p => [p.source, p.writable])).toEqual([
      ['bundle', false], ['bundle', false], ['profile', true], ['home', true],
    ])
    expect(listing.places[1].path).toBe(join(bundleDir(), 'presets', 'standard.patch.yml'))
  })

  it('grades the declaration\'s own plugin rows', async () => {
    const listing = await ok<PresetListing>('preset:list', 'a', 'decl')
    // Neither preset's rows resolve here — the fixture install has no packages —
    // and the `!!js` gate is left undecided rather than reported as missing.
    expect(listing.grades.map(cell => `${cell.presetId}:${cell.level}/`)).toEqual([
      'standard:incomplete/', 'mine:incomplete/',
    ])
    const mine = listing.grades.find(cell => cell.presetId === 'mine')
    // The `!!js` GATE is on `disabled`, so the host would not start that row:
    // it counts as skipped, and only a `!!js` NAME is left undecided.
    expect(mine).toMatchObject({
      profile: 'decl', skipped: 1, conditional: 0, missing: [{ name: '@deepseek-ai/dsh-persona' }],
    })
  })

  it('carries a broken declaration with its reason instead of dropping it', async () => {
    mkDeclaringProfile(...[
      '    - id: local-preset-broken',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: broken',
      '        plugins: nope',
    ])
    const listing = await ok<PresetListing>('preset:list', 'a', 'decl')
    expect(listing.presets.find(p => p.id === 'broken')?.broken)
      .toBe('the composition must be a top-level list of plugin rows')
  })

  it('reports the retired root\'s directories, which nothing reads any more', async () => {
    mkPreset('liangshen')
    const listing = await ok<PresetListing>('preset:list', 'a', 'decl')
    expect(listing.legacy).toEqual([
      {
        id: 'liangshen',
        dir: join(userRoot(), 'liangshen'),
        taken: false,
      },
    ])
    // And they are NOT in the roster: the model stopped reading that root.
    expect(listing.presets.map(p => p.id)).toEqual(['standard', 'mine'])
  })
})

describe('the declaration-model writes', () => {
  beforeEach(() => {
    rmSync(userRoot(), { recursive: true, force: true })
    mkProfile('decl', ['@deepseek-ai/dsh-web-app'])
    mkPresetBundle()
    mkDeclaringProfile()
  })

  it('edits the display scalars and leaves the plugins block byte for byte', async () => {
    const before = readFileSync(patchPath('decl'), 'utf8')
    expect(await ok<boolean>('preset:saveMeta', 'a', 'decl', 'mine', {
      name: 'Renamed', description: '', order: null,
    })).toBe(true)
    const after = readFileSync(patchPath('decl'), 'utf8')
    expect(after).toContain('        name: Renamed')
    expect(after).not.toContain('Only bash.')
    expect(after).not.toContain('        order: 3')
    expect(after).toContain("            disabled: !!js process.platform === 'win32'")
    expect(after).toContain("            name: '@deepseek-ai/dsh-persona'")
    expect(before).toContain('        description: Only bash.')
  })

  it('refuses to edit a declaration a bundle layer owns', async () => {
    expect(await call('preset:saveMeta', 'a', 'decl', 'standard', { name: 'x', description: '', order: null }))
      .toMatchObject({ ok: false, code: 'preset.readOnly' })
    expect(readFileSync(join(bundleDir(), 'presets', 'standard.patch.yml'), 'utf8')).not.toContain('name: x')
  })

  it('copies a declaration into this profile, plugins verbatim', async () => {
    expect(await ok<boolean>('preset:copy', 'a', 'decl', 'mine', 'copy', 'Copy')).toBe(true)
    const written = readFileSync(patchPath('decl'), 'utf8')
    expect(written).toContain('    - id: local-preset-copy')
    expect(written).toContain('        id: copy')
    expect(written).toContain('        name: Copy')
    // The description travels with the copy; the source's name and order do not.
    expect(written).toContain('        description: Only bash.')
    expect(written).toContain("            disabled: !!js process.platform === 'win32'")
    // The bundle layer is never written to.
    expect(readFileSync(join(bundleDir(), 'presets', 'standard.patch.yml'), 'utf8')).not.toContain('copy')
  })

  it('copies a bundle declaration verbatim, and refuses a taken id', async () => {
    expect(await ok<boolean>('preset:copy', 'a', 'decl', 'standard', 'std-copy', 'Std')).toBe(true)
    expect(readFileSync(patchPath('decl'), 'utf8')).toContain('    - id: local-preset-std-copy')
    expect(await call('preset:copy', 'a', 'decl', 'mine', 'standard', 'x'))
      .toMatchObject({ ok: false, code: 'preset.exists' })
    expect(await call('preset:copy', 'a', 'decl', 'mine', '../escape', 'x'))
      .toMatchObject({ ok: false, code: 'preset.badId' })
  })

  it('refuses an id whose loader row is already inserted, in every line shape', async () => {
    // A row that is already there keeps `local-preset-taken` occupied even when
    // the roster does not show its preset — a DISABLED declaration is skipped by
    // readDeclarations, so this guard is the only thing left between a create and
    // a duplicate loader row id, and the host answers a duplicate by refusing to
    // boot the WHOLE profile. A raw text search for "- id: x\n" misses the CRLF,
    // the missing trailing newline and the extra space; the structural walk finds
    // the row in all three.
    const occupied = [
      '    - id: local-preset-taken',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      disabled: true',
      '      config:',
      '        id: taken',
    ]
    const base = ['- insert:', ...DECLARED_ROW, ...occupied, ''].join('\n')
    const shapes: [string, string][] = [
      ['LF with a trailing newline', base],
      ['CRLF', base.replace(/\n/g, '\r\n')],
      ['no trailing newline', base.replace(/\n$/, '')],
      ['an extra space after the colon', base.replace('- id: local-preset-taken', '- id:  local-preset-taken')],
    ]
    for (const [label, text] of shapes) {
      writeFileSync(patchPath('decl'), text)
      // Nothing else can refuse it: the disabled row is not in the roster.
      const listing = await ok<PresetListing>('preset:list', 'a', 'decl')
      expect(listing.presets.map(p => p.id), label).not.toContain('taken')
      // The source is still readable in every shape — a CRLF file used to lose the
      // whole roster, which would refuse this call for the wrong reason and hide
      // the guard being tested.
      expect(listing.presets.map(p => p.id), label).toContain('mine')
      expect(await call('preset:copy', 'a', 'decl', 'mine', 'taken', 'x'), label)
        .toMatchObject({ ok: false, code: 'preset.exists' })
    }
  })

  it('does not read a plugin row inside a roster as a taken loader id', async () => {
    // `config.plugins` holds the declaration's private plugin rows, not loader
    // entries, so an id that merely looks like one cannot collide and must not
    // refuse the create. The substring is present in the text either way — only a
    // structural read can tell the two apart.
    const roster = [
      '    - id: local-preset-mine',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: mine',
      '        plugins:',
      '          - id: local-preset-taken',
      "            name: '@deepseek-ai/dsh-persona'",
    ]
    writeFileSync(patchPath('decl'), ['- insert:', ...roster, ''].join('\n'))
    expect(await ok<boolean>('preset:copy', 'a', 'decl', 'mine', 'taken', 'Taken')).toBe(true)
    const written = readFileSync(patchPath('decl'), 'utf8')
    expect(written).toContain('    - id: local-preset-taken')
    expect(written).toContain('        id: taken')
  })

  it('removes a declaration this profile owns, and refuses one it does not', async () => {
    expect(await ok<boolean>('preset:delete', 'a', 'decl', 'mine')).toBe(true)
    const after = readFileSync(patchPath('decl'), 'utf8')
    expect(after).not.toContain('local-preset-mine')
    expect(await call('preset:delete', 'a', 'decl', 'standard')).toMatchObject({ ok: false, code: 'preset.readOnly' })
    expect(await call('preset:delete', 'a', 'decl', 'nope')).toMatchObject({ ok: false, code: 'preset.notFound' })
  })

  it('reveals the folder holding the declaring file, and opens the file itself', async () => {
    expect(await ok<boolean>('preset:reveal', 'a', 'decl', 'mine')).toBe(true)
    expect(openPath).toHaveBeenCalledWith(profileDir('decl'))
    expect(await ok<boolean>('preset:reveal', 'a', 'decl', 'standard')).toBe(true)
    expect(openPath).toHaveBeenCalledWith(join(bundleDir(), 'presets'))
    expect(await ok<boolean>('preset:openEditor', 'a', 'decl', 'mine')).toBe(true)
    expect(openExternal).toHaveBeenCalledWith(`vscode://file/${patchPath('decl').replace(/\\/g, '/')}`)
  })

  it('migrates a directory the retired root still holds into this profile', async () => {
    mkPreset('liangshen')
    writeFileSync(join(userRoot(), 'liangshen', 'agent.cordis.yml'),
      "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    prefix: hello\n")
    writeFileSync(join(userRoot(), 'liangshen', 'preset.yml'), 'name: 梁神模式\norder: 5\n')
    // Before the migration the page can only say it will not be loaded.
    const before = await ok<PresetListing>('preset:list', 'a', 'decl')
    expect(before.legacy.map(p => [p.id, p.taken])).toEqual([['liangshen', false]])
    expect(before.presets.map(p => p.id)).toEqual(['standard', 'mine'])

    expect(await ok<boolean>('preset:migrate', 'a', 'decl', 'liangshen')).toBe(true)
    const written = readFileSync(patchPath('decl'), 'utf8')
    expect(written).toContain('    - id: local-preset-liangshen')
    expect(written).toContain('        id: liangshen')
    expect(written).toContain('        name: 梁神模式')
    expect(written).toContain('        order: 5')
    expect(written).toContain('            prefix: hello')
    // The directory is left exactly where it is.
    expect(existsSync(join(userRoot(), 'liangshen', 'agent.cordis.yml'))).toBe(true)
    // It is a declaration now, so the page lists it as one. `order: 5` sorts it
    // after the two declaring 1 and 3, and the directory it came from is still
    // on disk — reported as ALREADY supplied, which is what tells a person the
    // leftover is now safe to remove.
    const listing = await ok<PresetListing>('preset:list', 'a', 'decl')
    expect(listing.presets.map(p => p.id)).toEqual(['standard', 'mine', 'liangshen'])
    expect(listing.legacy).toEqual([{ id: 'liangshen', dir: join(userRoot(), 'liangshen'), name: '梁神模式', taken: true }])
  })

  it('refuses a migration whose id is declared, unknown, ill-formed, or unreadable', async () => {
    // A directory named like a preset dsh already declares: migrating it would
    // declare the same id twice.
    mkPreset('standard')
    expect(await call('preset:migrate', 'a', 'decl', 'standard')).toMatchObject({ ok: false, code: 'preset.exists' })
    expect(await call('preset:migrate', 'a', 'decl', 'nope')).toMatchObject({ ok: false, code: 'preset.notFound' })
    expect(await call('preset:migrate', 'a', 'decl', '../escape')).toMatchObject({ ok: false, code: 'preset.badId' })
    mkdirSync(join(userRoot(), 'ghost'), { recursive: true })
    expect(await call('preset:migrate', 'a', 'decl', 'ghost'))
      .toMatchObject({ ok: false, code: 'preset.badComposition' })
  })
})

// ── the home layer, a boot-stopping conflict, and what a click costs ─────────

describe('a declaration in the machine-level home patch', () => {
  beforeEach(() => {
    rmSync(userRoot(), { recursive: true, force: true })
    mkProfile('decl', ['@deepseek-ai/dsh-web-app'])
    mkPresetBundle()
    mkDeclaringProfile()
    mkHomeDeclaringProfile()
  })

  it('is listed as read-only here, and every write to it is refused untouched', async () => {
    const listing = await ok<PresetListing>('preset:list', 'a', 'decl')
    // The person's own — `home` is not the deployment's — but not this page's to
    // change: every profile of this machine composes that patch.
    expect(listing.presets.find(preset => preset.id === 'machine'))
      .toMatchObject({ source: 'home', trust: 'user', editable: false })

    const homeBefore = readFileSync(homePatch(), 'utf8')
    const profileBefore = readFileSync(patchPath('decl'), 'utf8')
    expect(await call('preset:saveMeta', 'a', 'decl', 'machine', { name: 'x', description: '', order: null }))
      .toMatchObject({ ok: false, code: 'preset.homeReadOnly' })
    expect(await call('preset:delete', 'a', 'decl', 'machine'))
      .toMatchObject({ ok: false, code: 'preset.homeReadOnly' })
    // Byte for byte: the refusal is decided before anything is written, so
    // neither the home patch nor the profile's own layer moved.
    expect(readFileSync(homePatch(), 'utf8')).toBe(homeBefore)
    expect(readFileSync(patchPath('decl'), 'utf8')).toBe(profileBefore)
  })

  it('is still a legal SOURCE for a copy, which lands in this profile', async () => {
    expect(await ok<boolean>('preset:copy', 'a', 'decl', 'machine', 'copied', 'Copied')).toBe(true)
    const written = readFileSync(patchPath('decl'), 'utf8')
    expect(written).toContain('    - id: local-preset-copied')
    expect(written).toContain("            name: '@deepseek-ai/dsh-persona'")
    // The home layer is not written to by a copy either.
    expect(readFileSync(homePatch(), 'utf8')).toContain('local-preset-machine')
  })
})

describe('a loader row id two layers insert', () => {
  beforeEach(() => {
    rmSync(userRoot(), { recursive: true, force: true })
    mkProfile('decl', ['@deepseek-ai/dsh-web-app'])
    mkPresetBundle()
    // The bundle's second patch file already inserts `preset-standard`; this
    // profile's layer inserts the SAME row id, which the host refuses to boot.
    mkDeclaringProfile(...[
      '    - id: preset-standard',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: standard',
      '        plugins: []',
    ])
  })

  it('is reported to the page, which would otherwise show a healthy roster', async () => {
    const listing = await ok<PresetListing>('preset:list', 'a', 'decl')
    // The fold keeps one row per row id — that is what a replace looks like —
    // so the roster alone cannot tell the two apart.
    expect(listing.presets.filter(preset => preset.id === 'standard')).toHaveLength(1)
    expect(listing.warnings.some(line => line.includes('preset-standard'))).toBe(true)
    expect(listing.warnings.some(line => line.includes('duplicate loader entry id'))).toBe(true)
  })
})

describe('what one preset action reads', () => {
  beforeEach(() => {
    rmSync(userRoot(), { recursive: true, force: true })
    mkProfile('decl', ['@deepseek-ai/dsh-web-app'])
    mkPresetBundle()
    mkDeclaringProfile()
  })

  it('locates a preset for "open" without grading the roster', async () => {
    counters.compose = 0
    counters.grade = 0
    counters.resolve = 0
    expect(await ok<boolean>('preset:reveal', 'a', 'decl', 'mine')).toBe(true)
    expect(openPath).toHaveBeenCalledWith(profileDir('decl'))
    // Locating is one composition and NO grading: walking every row of the
    // roster through a resolver is what a click used to cost.
    expect(counters.compose).toBe(1)
    expect(counters.grade).toBe(0)
    expect(counters.resolve).toBe(0)

    // The counter itself is alive: listing DOES grade.
    counters.compose = 0
    counters.grade = 0
    expect(await ok<PresetListing>('preset:list', 'a', 'decl')).toBeTruthy()
    expect(counters.compose).toBe(1)
    expect(counters.grade).toBe(1)
    expect(counters.resolve).toBeGreaterThan(0)
  })

  it('composes the layer stack once per write', async () => {
    counters.compose = 0
    counters.grade = 0
    expect(await ok<boolean>('preset:saveMeta', 'a', 'decl', 'mine', {
      name: 'Renamed', description: '', order: null,
    })).toBe(true)
    expect(counters.compose).toBe(1)
    expect(counters.grade).toBe(0)

    counters.compose = 0
    counters.grade = 0
    expect(await ok<boolean>('preset:copy', 'a', 'decl', 'mine', 'copy', 'Copy')).toBe(true)
    expect(counters.compose).toBe(1)
    expect(counters.grade).toBe(0)
  })
})

describe('what "open" reads on a directory-model dsh', () => {
  // No `beforeEach` of its own: the fixture user root this page scans is the
  // one the outer setup just built.
  it('locates the preset directory without grading the roster', async () => {
    counters.compose = 0
    counters.grade = 0
    expect(await ok<boolean>('preset:reveal', 'a', 'alpha', 'mine')).toBe(true)
    expect(openPath).toHaveBeenCalledWith(join(userRoot(), 'mine'))
    expect(counters.compose).toBe(1)
    expect(counters.grade).toBe(0)
    // One probe remains, and it is finding the ROOT this roster is scanned from
    // (`presetRoots` resolves the built-in package), not grading a row.
    expect(counters.resolve).toBe(1)
  })
})

// ── no model at all ─────────────────────────────────────────────────────────

describe('a profile that mounts no preset model', () => {
  it('names no definition source, because nothing reads one there', async () => {
    mkProfile('none')
    // The retired root is on disk and this profile mounts no presets package:
    // the page says so, and must not offer that directory as a "source" of a
    // roster that does not exist.
    mkPreset('liangshen')
    const listing = await ok<PresetListing>('preset:list', 'a', 'none')
    expect(listing).toMatchObject({
      model: 'none', presets: [], grades: [], places: [], legacy: [], warnings: [],
    })
    // And "open" has nothing to point at, not even that directory.
    expect(await call('preset:reveal', 'a', 'none', 'liangshen'))
      .toMatchObject({ ok: false, code: 'preset.notFound' })
    expect(openPath).not.toHaveBeenCalled()
  })
})
