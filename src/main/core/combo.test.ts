/**
 * Composed plugin list / patch-layer stack: bundle resolution, disabled overrides,
 * layer composition, bundle reconcile and unclaimed-bundle detection. All built
 * against a disposable profile tree with an explicit (anchor-less) dsh context.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextForEntry } from './appState.ts'
import {
  composeProfileLayers, defaultConfigText, listComboPlugins, listUnclaimedBundles,
  reconcileBundles, resolveBundlePatch,
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

/** A manually installed bundle package declaring `dsh.bundle`. */
function mkBundlePkg(p: string, bundle: string): void {
  const dir = join(profileDir(p), 'node_modules', bundle)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { bundle: true } }))
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
    expect(layers[2].rows[0].id).toBe('homeRow')
  })

  it('omits the profile layer when its patch is blank', () => {
    mkProfile('p', [], {})
    mkUserPatch('p', '   ')
    expect(composeProfileLayers(ctx(), 'p').map(l => l.source)).toEqual([])
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
