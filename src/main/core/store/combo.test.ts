/**
 * Composed plugin list / patch-layer stack: bundle resolution, disabled overrides,
 * layer composition, bundle reconcile and unclaimed-bundle detection. All built
 * against a disposable profile tree with an explicit (anchor-less) dsh context.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { contextForEntry } from '../profile/appState.ts'
import {
  composeLayerTexts, composeProfileLayers, defaultConfigText, findInsertConflicts, listComboPlugins, listMcpServers,
  listMissingBundles, listUnclaimedBundles, reconcileBundles, resolveBundlePatch, resolveBundlePatches,
  validateComposition,
} from './combo.ts'

let root: string
const home = (): string => join(root, 'home')
const profiles = (): string => join(home(), 'profiles')
const ctx = (): ReturnType<typeof contextForEntry> =>
  contextForEntry({ id: 'a', name: 'dsh@a', execPath: '/fake/a', version: 'a', home: home() })

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-combo-')) })

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(profiles(), { recursive: true })
})

function profileDir(p: string): string { return join(profiles(), p) }

/** A profile manifest with bundles + deps. */
function mkProfile(p: string, bundles: string[] = [], deps: Record<string, string> = {}): void {
  const dir = profileDir(p)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    dependencies: deps,
    dsh: { profile: { bundles } },
  }))
}

/** A bundle layer's `cordis.patch.yml`, installed in the profile's node_modules. */
function mkBundle(p: string, bundle: string, text: string): void {
  const dir = join(profileDir(p), 'node_modules', bundle)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.patch.yml'), text)
}

/** A manually installed bundle package declaring `dsh.bundle.patch`. */
function mkBundlePkg(p: string, bundle: string): void {
  const dir = join(profileDir(p), 'node_modules', bundle)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { bundle: { patch: './cordis.patch.yml' } } }))
}

/** A bundle whose manifest declares `files` and whose patch files all exist. */
function mkMultiPatch(p: string, bundle: string, files: string[], rows: string[]): void {
  const dir = join(profileDir(p), 'node_modules', bundle)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { bundle: { patch: files } } }))
  files.forEach((rel, index) => {
    const path = join(dir, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, rows[index] ?? '')
  })
}

/** A bundle package declaring SEVERAL patch files (`dsh.bundle.patch` as a list),
 * the shape 0.2.0-rc.1's web-app bundle uses for its preset declarations. */
function mkBundleFiles(p: string, bundle: string, declared: string[], files: Record<string, string>): void {
  const dir = join(profileDir(p), 'node_modules', bundle)
  for (const [rel, text] of Object.entries(files)) {
    const at = join(dir, rel)
    mkdirSync(dirname(at), { recursive: true })
    writeFileSync(at, text)
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { bundle: { patch: declared } } }))
}

function mkUserPatch(p: string, text: string): void {
  writeFileSync(join(profileDir(p), 'cordis.patch.yml'), text)
}

describe('resolveBundlePatch', () => {
  it('finds a bundle patch in the profile node_modules', () => {
    mkProfile('p', [], {})
    mkBundle('p', '@deepseek-ai/dsh-base', '- id: a\n')
    const found = resolveBundlePatch(ctx(), '@deepseek-ai/dsh-base', 'p')
    expect(found).toBe(join(profileDir('p'), 'node_modules', '@deepseek-ai/dsh-base', 'cordis.patch.yml'))
  })

  it('returns undefined when no candidate holds the patch', () => {
    mkProfile('p', [], {})
    expect(resolveBundlePatch(ctx(), 'missing', 'p')).toBeUndefined()
  })

  it("honours a bundle's declared dsh.bundle.patch filename", () => {
    mkProfile('p', ['b1'], {})
    const dir = join(profileDir('p'), 'node_modules', 'b1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { bundle: { patch: './custom.patch.yml' } } }))
    writeFileSync(join(dir, 'custom.patch.yml'), '- id: one\n')
    expect(resolveBundlePatch(ctx(), 'b1', 'p')).toBe(join(dir, 'custom.patch.yml'))
    expect(listComboPlugins(ctx(), 'p').map(r => r.id)).toEqual(['one'])
  })
})

describe('listComboPlugins', () => {
  it('collects bundle rows and applies user-patch disabled overrides', () => {
    mkProfile('p', ['b1'], {})
    mkBundle('p', 'b1', '- id: one\n  name: pkg-one\n- id: two\n  name: pkg-two\n  disabled: true\n')
    const rows = listComboPlugins(ctx(), 'p')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ id: 'one', name: 'pkg-one', bundle: 'b1', disabled: false })
    expect(rows[1]).toEqual({ id: 'two', name: 'pkg-two', bundle: 'b1', disabled: true })
  })

  it('re-enables a row the user patch unmasks', () => {
    mkProfile('p', ['b1'], {})
    mkBundle('p', 'b1', '- id: one\n  disabled: true\n')
    mkUserPatch('p', '- id: one\n  disabled: false\n')
    expect(listComboPlugins(ctx(), 'p')[0].disabled).toBe(false)
  })

  it('falls back to name="" and skips missing bundles', () => {
    mkProfile('p', ['gone', 'here'], {})
    mkBundle('p', 'here', '- id: x\n')
    expect(listComboPlugins(ctx(), 'p').map(r => r.bundle)).toEqual(['here'])
    expect(listComboPlugins(ctx(), 'p')[0].name).toBe('')
  })
})

describe('composeProfileLayers', () => {
  it('orders bundle, profile, then home layers', () => {
    mkProfile('p', ['b1'], {})
    mkBundle('p', 'b1', '- id: bundleRow\n')
    mkUserPatch('p', '- id: profileRow\n')
    // machine home layer applies last
    writeFileSync(join(home(), 'cordis.patch.yml'), '- id: homeRow\n')

    const layers = composeProfileLayers(ctx(), 'p')
    expect(layers.map(l => l.source)).toEqual(['bundle', 'profile', 'home'])
    expect(layers[0].bundle).toBe('b1')
    expect(layers[1].label).toBe('p')
    expect(layers[2].files[0].rows[0].id).toBe('homeRow')
    // A single-file layer carries no file qualifier.
    expect(layers[0].files).toEqual([{ rows: [{ id: 'bundleRow', name: undefined, disabled: false, hasConfig: false, hasInsert: false }] }])
  })

  it('omits the profile layer when its patch is blank', () => {
    mkProfile('p', [], {})
    mkUserPatch('p', '   ')
    expect(composeProfileLayers(ctx(), 'p').map(l => l.source)).toEqual([])
  })

  // The host's own layer unit is the bundle package (its `profile.layers` holds
  // one entry per package with a `patchPaths` list), and a bundle is the only
  // thing a person can enable, disable or remove. Listing one declared file as
  // one layer showed 0.2.0-rc1's web-app bundle as five cards with the same name.
  it('groups a bundle\'s several patch files into one layer, qualified by file', () => {
    mkProfile('p', ['b1', 'b2'], {})
    mkBundle('p', 'b1', '- id: base\n')
    mkMultiPatch('p', 'b2', ['./cordis.patch.yml', './presets/standard.patch.yml'],
      ['- id: shell\n', '- id: preset-standard\n'])

    const layers = composeProfileLayers(ctx(), 'p')
    expect(layers.map(l => l.bundle)).toEqual(['b1', 'b2'])
    expect(layers[0].files.map(f => f.file)).toEqual([undefined])
    expect(layers[1].files.map(f => f.file)).toEqual(['cordis.patch.yml', 'presets/standard.patch.yml'])
    expect(layers[1].files.map(f => f.rows.map(r => r.id))).toEqual([['shell'], ['preset-standard']])
  })

  // Two entries of `dsh.profile.bundles` are two layers to the host, so merging
  // them would under-report the stack.
  it('keeps a bundle listed twice as two layers', () => {
    mkProfile('p', ['b1', 'b1'], {})
    mkMultiPatch('p', 'b1', ['./cordis.patch.yml', './presets/standard.patch.yml'],
      ['- id: shell\n', '- id: preset-standard\n'])
    expect(composeProfileLayers(ctx(), 'p').map(l => l.files.length)).toEqual([2, 2])
  })
})

describe('reconcileBundles', () => {
  it('adds dependency-managed bundles and removes dormant ones', () => {
    mkProfile('p', ['gold'], { live: 'link:/x', gold: 'link:/x', dormant: 'link:/x' })
    mkBundlePkg('p', 'live')
    // 'gold' is a bundle-layer entry whose dependency no longer declares dsh.bundle → drop
    // 'dormant' is a dependency not present → stays out (declaresBundle false)

    const { added, removed } = reconcileBundles(ctx(), 'p')
    expect(removed).toEqual(['gold'])
    expect(added).toEqual(['live'])
    // manifest rewritten
    const manifest = JSON.parse(readFileSync(join(profileDir('p'), 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toEqual(['live'])
  })

  it('throws for a missing profile manifest', () => {
    expect(() => reconcileBundles(ctx(), 'nope')).toThrow(/不存在/)
  })
})

describe('defaultConfigText', () => {
  it("returns the first bundle layer's config for a row, else empty", () => {
    mkProfile('p', ['b1'], {})
    mkBundle('p', 'b1', '- id: rowA\n  config:\n    k: v\n')
    expect(defaultConfigText(ctx(), 'p', 'rowA')).toContain('k: v')
    expect(defaultConfigText(ctx(), 'p', 'nope')).toBe('')
  })
})

describe('listUnclaimedBundles', () => {
  it('lists dependency bundles not activated as layers', () => {
    mkProfile('p', ['active'], { active: 'link:/x', stray: 'link:/x' })
    mkBundlePkg('p', 'active')
    mkBundlePkg('p', 'stray')
    expect(listUnclaimedBundles(ctx(), 'p')).toEqual(['stray'])
  })
})

describe('findInsertConflicts', () => {
  it('flags an id inserted by two bundle layers, naming both', () => {
    mkProfile('p', ['b1', 'b2'], {})
    mkBundle('p', 'b1', '- insert:\n    - id: shared\n      name: pkg\n')
    mkBundle('p', 'b2', '- insert:\n    - id: shared\n      name: pkg\n')
    expect(findInsertConflicts(ctx(), 'p')).toEqual([
      { id: 'shared', layers: [{ source: 'bundle', bundle: 'b1' }, { source: 'bundle', bundle: 'b2' }] },
    ])
  })

  it('does not flag an id merely patched (not inserted) by another layer', () => {
    mkProfile('p', ['b1', 'b2'], {})
    mkBundle('p', 'b1', '- insert:\n    - id: shared\n      name: pkg\n')
    mkBundle('p', 'b2', '- id: shared\n  config:\n    k: v\n')
    expect(findInsertConflicts(ctx(), 'p')).toEqual([])
  })

  it('flags a profile-layer insert colliding with a bundle insert', () => {
    mkProfile('p', ['b1'], {})
    mkBundle('p', 'b1', '- insert:\n    - id: shared\n      name: pkg\n')
    mkUserPatch('p', '- insert:\n    - id: shared\n      name: pkg\n')
    expect(findInsertConflicts(ctx(), 'p')).toEqual([
      { id: 'shared', layers: [{ source: 'bundle', bundle: 'b1' }, { source: 'profile', label: 'p' }] },
    ])
  })

  it('includes --patch overlays passed at launch', () => {
    mkProfile('p', [], {})
    mkUserPatch('p', '- insert:\n    - id: shared\n      name: pkg\n')
    const overlay = join(root, 'overlay.yml')
    writeFileSync(overlay, '- insert:\n    - id: shared\n      name: pkg\n')
    expect(findInsertConflicts(ctx(), 'p', [overlay])).toEqual([
      { id: 'shared', layers: [{ source: 'profile', label: 'p' }, { source: 'patch', label: 'overlay.yml' }] },
    ])
  })

  // The 0.2.0-rc.1 false positive: a bundle declaring an ARRAY of patch files,
  // four of them agent-preset declarations whose `config.plugins` rosters reuse
  // the base bundle's plugin ids. Read as inserts, ~30 of them "collided" with
  // the base layer and the profile was reported unbootable while it booted fine.
  it('does not read a preset declaration\'s plugin roster as inserted entries', () => {
    mkProfile('p', ['b1', 'b2'], {})
    mkBundle('p', 'b1', '- insert:\n    - id: tool-bash\n      name: base\n')
    mkBundleFiles('p', 'b2', ['./cordis.patch.yml', './presets/standard.patch.yml'], {
      'cordis.patch.yml': '- insert:\n    - id: agent-preset-registry\n      name: reg\n',
      'presets/standard.patch.yml': [
        '- insert:',
        '    - id: preset-standard',
        "      name: '@deepseek-ai/dsh-agent-preset'",
        '      config:',
        '        id: standard',
        '        plugins:',
        '          - id: tool-bash',
        "            name: '@deepseek-ai/dsh-tool-bash'",
        '            disabled: true',
        '          - id: persona',
        "            name: '@deepseek-ai/dsh-persona'",
        '',
      ].join('\n'),
    })
    expect(findInsertConflicts(ctx(), 'p')).toEqual([])
    expect(validateComposition(ctx(), 'p').ok).toBe(true)
    // The composed plugin list keeps the real rows only: the base layer's
    // `tool-bash`, the registry mount and the declaration itself.
    expect(listComboPlugins(ctx(), 'p').map(row => row.id)).toEqual([
      'tool-bash', 'agent-preset-registry', 'preset-standard',
    ])
  })
})

describe('listMissingBundles / validateComposition', () => {
  it('reports a listed bundle with no resolvable patch', () => {
    mkProfile('p', ['present', 'gone'], {})
    mkBundle('p', 'present', '- id: a\n')
    expect(listMissingBundles(ctx(), 'p')).toEqual(['gone'])
  })

  it('flags conflicts and missing bundles; ok when clean', () => {
    mkProfile('p', ['b1', 'b2'], {})
    mkBundle('p', 'b1', '- insert:\n    - id: shared\n      name: pkg\n')
    mkBundle('p', 'b2', '- insert:\n    - id: shared\n      name: pkg\n')
    const bad = validateComposition(ctx(), 'p')
    expect(bad.ok).toBe(false)
    expect(bad.conflicts.map(c => c.id)).toEqual(['shared'])
    expect(bad.missingBundles).toEqual([])

    mkProfile('clean', ['b1'], {})
    mkBundle('clean', 'b1', '- insert:\n    - id: only\n      name: pkg\n')
    expect(validateComposition(ctx(), 'clean').ok).toBe(true)
  })

  it('reports a manifest error without throwing', () => {
    const v = validateComposition(ctx(), 'nope')
    expect(v.ok).toBe(false)
    expect(v.manifestError).toBeDefined()
  })
})

describe('listMcpServers', () => {
  const ROW = (id: string, serverName: string, command = 'npx') => [
    '- insert:',
    `    - id: ${id}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${serverName}`,
    '        transport: stdio',
    `        command: ${command}`,
    '',
  ].join('\n')

  it('reads profile and home rows, tagging each with its layer', () => {
    mkProfile('p', [], {})
    mkUserPatch('p', ROW('mcp-a', 'alpha'))
    writeFileSync(join(home(), 'cordis.patch.yml'), ROW('mcp-b', 'beta'))
    const servers = listMcpServers(ctx(), 'p')
    expect(servers.map(s => [s.id, s.serverName, s.layer])).toEqual([
      ['mcp-a', 'alpha', 'profile'],
      ['mcp-b', 'beta', 'home'],
    ])
    expect(servers.flatMap(s => s.issues)).toEqual([])
  })

  it('names a serverName claimed by two layers (a real dsh load failure)', () => {
    mkProfile('p', [], {})
    mkUserPatch('p', ROW('mcp-a', 'same'))
    writeFileSync(join(home(), 'cordis.patch.yml'), ROW('mcp-b', 'same'))
    const issues = listMcpServers(ctx(), 'p').flatMap(s => s.issues)
    expect(issues.map(i => i.kind)).toEqual(['duplicate-server-name', 'duplicate-server-name'])
    expect(issues[0].other).toEqual({ layer: 'home', id: 'mcp-b' })
  })

  it('reads a row shipped by a bundle layer', () => {
    mkProfile('p', ['b1'], {})
    mkBundle('p', 'b1', ROW('mcp-shipped', 'shipped'))
    const servers = listMcpServers(ctx(), 'p')
    expect(servers).toHaveLength(1)
    expect(servers[0].layer).toBe('bundle')
    expect(servers[0].bundle).toBe('b1')
  })

  it('returns nothing for a profile with no MCP rows', () => {
    mkProfile('p', [], {})
    expect(listMcpServers(ctx(), 'p')).toEqual([])
  })
})

/**
 * Bundle resolution against a pnpm-shaped install — the shape an official install
 * actually produces.
 *
 * `<anchor>/node_modules/@deepseek-ai/` holds ONLY `dsh`; every other bundle a
 * manifest names is a transitive dependency of it, living beside dsh's body in
 * the store. A plain `join(root, name)` probe reports all of them as missing,
 * which made `validateComposition` call a healthy profile broken and let
 * `reconcileBundles` delete those layers from `dsh.profile.bundles`.
 *
 * The anchor here is a real directory tree, so `execPath` simply points inside it
 * (`resolveInstallAnchor` walks up to the nearest `package.json`). No mocking —
 * this file stays all-filesystem.
 */
describe('on a pnpm-shaped install', () => {
  const anchor = (): string => join(root, 'install')
  const nm = (): string => join(anchor(), 'node_modules')
  /** dsh's real body in the virtual store. */
  const storeDir = (): string => join(nm(), '.pnpm', '@deepseek-ai+dsh@1.0.0_hash')
  const dshReal = (): string => join(storeDir(), 'node_modules', '@deepseek-ai', 'dsh')

  const pnpmCtx = (): ReturnType<typeof contextForEntry> =>
    contextForEntry({
      id: 'a', name: 'dsh@a', execPath: join(nm(), '.bin', 'dsh.cmd'), version: '1.0.0', home: home(),
    })

  /** The install: the anchor's manifest, `dsh` junctioned into the store, and
   * nothing else under `@deepseek-ai/`. */
  function mkAnchor(): void {
    mkdirSync(join(nm(), '.bin'), { recursive: true })
    writeFileSync(join(nm(), '.bin', 'dsh.cmd'), '')
    writeFileSync(join(anchor(), 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '1.0.0' } }))
    mkdirSync(dshReal(), { recursive: true })
    writeFileSync(join(dshReal(), 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' }))
    mkdirSync(join(nm(), '@deepseek-ai'), { recursive: true })
    symlinkSync(dshReal(), join(nm(), '@deepseek-ai', 'dsh'), 'junction')
  }

  /** A bundle only dsh depends on: its body sits in the store beside dsh's,
   * reachable through the lookup chain and nowhere else. */
  function mkStoreBundle(bundle: string, patch: string, rel = './cordis.patch.yml'): string {
    const dir = join(storeDir(), 'node_modules', bundle)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: bundle, version: '1.0.0', dsh: { bundle: { patch: rel } },
    }))
    writeFileSync(join(dir, rel), patch)
    return dir
  }

  beforeEach(() => { mkAnchor() })

  it('resolves a bundle that exists only as a transitive dependency', () => {
    mkProfile('p', ['@deepseek-ai/dsh-base'], {})
    const dir = mkStoreBundle('@deepseek-ai/dsh-base', '- id: base-row\n')
    // Faithful fixture: the flat root really does hold `dsh` and nothing else.
    expect(existsSync(join(nm(), '@deepseek-ai', 'dsh-base'))).toBe(false)
    expect(resolveBundlePatch(pnpmCtx(), '@deepseek-ai/dsh-base', 'p')).toBe(join(dir, 'cordis.patch.yml'))
  })

  it("honours a store-installed bundle's declared patch filename", () => {
    mkProfile('p', ['@deepseek-ai/dsh-web-app'], {})
    const dir = mkStoreBundle('@deepseek-ai/dsh-web-app', '- id: web-row\n', './custom.patch.yml')
    expect(resolveBundlePatch(pnpmCtx(), '@deepseek-ai/dsh-web-app', 'p')).toBe(join(dir, 'custom.patch.yml'))
  })

  it('composes every declared layer and reports none of them missing', () => {
    mkProfile('p', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], {})
    mkStoreBundle('@deepseek-ai/dsh-base', '- id: base-row\n  name: pkg-base\n')
    mkStoreBundle('@deepseek-ai/dsh-web-app', '- id: web-row\n')
    expect(listComboPlugins(pnpmCtx(), 'p').map(r => [r.id, r.bundle])).toEqual([
      ['base-row', '@deepseek-ai/dsh-base'],
      ['web-row', '@deepseek-ai/dsh-web-app'],
    ])
    expect(listMissingBundles(pnpmCtx(), 'p')).toEqual([])
    expect(validateComposition(pnpmCtx(), 'p').ok).toBe(true)
    expect(composeProfileLayers(pnpmCtx(), 'p').map(l => l.source)).toEqual(['bundle', 'bundle'])
  })

  it('sees an activated bundle as declared, so reconcile leaves it alone', () => {
    mkProfile('p', ['@deepseek-ai/dsh-web-app'], { '@deepseek-ai/dsh-web-app': 'link:/nowhere' })
    mkStoreBundle('@deepseek-ai/dsh-web-app', '- id: web-row\n')
    // The silent-data-loss regression: before, the layer resolved nowhere, so
    // reconcile reported it as removed and rewrote the manifest.
    expect(reconcileBundles(pnpmCtx(), 'p')).toEqual({ added: [], removed: [] })
    expect(JSON.parse(readFileSync(join(profileDir('p'), 'package.json'), 'utf8')).dsh.profile.bundles)
      .toEqual(['@deepseek-ai/dsh-web-app'])
  })

  it('offers an installed-but-inactive bundle for activation', () => {
    mkProfile('p', [], { '@deepseek-ai/dsh-web-app': 'link:/nowhere' })
    mkStoreBundle('@deepseek-ai/dsh-web-app', '- id: web-row\n')
    expect(listUnclaimedBundles(pnpmCtx(), 'p')).toEqual(['@deepseek-ai/dsh-web-app'])
  })

  it('skips a dangling store entry rather than returning an unreadable path', () => {
    mkProfile('p', ['@deepseek-ai/dsh-ghost'], {})
    const scope = join(storeDir(), 'node_modules', '@deepseek-ai')
    mkdirSync(scope, { recursive: true })
    // A junction left by a previous install, its target long gone.
    symlinkSync(join(root, 'previous-version'), join(scope, 'dsh-ghost'), 'junction')
    expect(resolveBundlePatch(pnpmCtx(), '@deepseek-ai/dsh-ghost', 'p')).toBeUndefined()
    expect(listMissingBundles(pnpmCtx(), 'p')).toEqual(['@deepseek-ai/dsh-ghost'])
  })

  it('still resolves a flat install that has no dsh package to anchor a chain', () => {
    // Hand-assembled (non-pnpm) anchor: real dirs, and no `@deepseek-ai/dsh` for a
    // chain to start from — the case the flat `<anchor>/node_modules` root is for.
    const flat = join(root, 'flat-install')
    const dir = join(flat, 'node_modules', '@deepseek-ai', 'dsh-base')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: flat\n')
    writeFileSync(join(flat, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '1.0.0' } }))
    const flatCtx = contextForEntry({
      id: 'flat', name: 'dsh@flat', execPath: join(flat, 'node_modules', '.bin', 'dsh.cmd'),
      version: '1.0.0', home: home(),
    })
    mkProfile('p', ['@deepseek-ai/dsh-base'], {})
    expect(resolveBundlePatch(flatCtx, '@deepseek-ai/dsh-base', 'p')).toBe(join(dir, 'cordis.patch.yml'))
  })
})

// Since 0.2.0-rc.1 a bundle may declare an ordered LIST of patch files, and the
// shipped `dsh-web-app` does: `cordis.patch.yml` plus four `presets/*.patch.yml`
// carrying every agent-preset declaration. Reading only the string form dropped
// all four silently — no error, just an empty preset roster.
describe('a bundle that declares several patch files', () => {
  it('resolves every declared file, in declaration order', () => {
    mkProfile('p', ['b'], {})
    mkMultiPatch('p', 'b', ['./cordis.patch.yml', './presets/standard.patch.yml'],
      ['- id: base\n', '- id: preset-standard\n'])
    const dir = join(profileDir('p'), 'node_modules', 'b')
    expect(resolveBundlePatches(ctx(), 'b', 'p')).toEqual([
      join(dir, 'cordis.patch.yml'),
      join(dir, 'presets', 'standard.patch.yml'),
    ])
    // The single-file view is still the first one, unchanged.
    expect(resolveBundlePatch(ctx(), 'b', 'p')).toBe(join(dir, 'cordis.patch.yml'))
  })

  it('lists rows from every file, not just the first', () => {
    mkProfile('p', ['b'], {})
    mkMultiPatch('p', 'b', ['./cordis.patch.yml', './presets/standard.patch.yml'],
      ['- id: base\n', '- id: preset-standard\n'])
    expect(listComboPlugins(ctx(), 'p').map(r => r.id)).toEqual(['base', 'preset-standard'])
  })

  it('keeps a declared file list as the files of ONE layer, in application order', () => {
    mkProfile('p', ['b'], {})
    mkMultiPatch('p', 'b', ['./cordis.patch.yml', './presets/standard.patch.yml'],
      ['- id: base\n', '- id: preset-standard\n'])
    const layers = composeLayerTexts(ctx(), 'p')
    expect(layers).toHaveLength(1)
    expect(layers[0].bundle).toBe('b')
    expect(layers[0].files.map(f => [f.file, f.text])).toEqual([
      ['cordis.patch.yml', '- id: base\n'],
      ['presets/standard.patch.yml', '- id: preset-standard\n'],
    ])
  })

  it('reports the bundle when one of its declared files is missing', () => {
    mkProfile('p', ['b'], {})
    mkMultiPatch('p', 'b', ['./cordis.patch.yml', './presets/standard.patch.yml'],
      ['- id: base\n', '- id: preset-standard\n'])
    rmSync(join(profileDir('p'), 'node_modules', 'b', 'presets', 'standard.patch.yml'))
    // dsh drops the whole bundle layer when one of its patch files fails to load.
    expect(listMissingBundles(ctx(), 'p')).toEqual(['b'])
  })

  it('treats a declared-but-absent list as no declaration and falls back to the default name', () => {
    mkProfile('p', ['b'], {})
    const dir = join(profileDir('p'), 'node_modules', 'b')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { bundle: { patch: [] } } }))
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: fallback\n')
    expect(resolveBundlePatches(ctx(), 'b', 'p')).toEqual([join(dir, 'cordis.patch.yml')])
  })
})
