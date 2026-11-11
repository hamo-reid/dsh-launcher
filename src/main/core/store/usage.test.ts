/**
 * The usage scan: the one predicate that says whether a profile still references
 * a plugin. Both the detach path and the "is it in use by a running profile"
 * guards read it, so what it does and does NOT count as a reference is the
 * behaviour worth locking here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginsUsing, scanPluginUsages } from './usage.ts'
import type { DshScope } from '../profile/appState.ts'

let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pm-usage-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const home = (): string => join(root, 'home')
const profiles = (): string => join(home(), 'profiles')
const scope = (id: string, name = `dsh@${id}`, h = home()): DshScope =>
  ({ id, name, version: '9.0.0', home: h })

/** Write one profile manifest; no manifest at all means "not a profile". */
function mkProfile(name: string, manifest?: Record<string, unknown>): void {
  const dir = join(profiles(), name)
  mkdirSync(dir, { recursive: true })
  if (manifest !== undefined) writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
}

/** A real directory at `node_modules/<pkg>` — what pnpm leaves for a real install. */
function mkInstalled(name: string, pkg: string): void {
  const dir = join(profiles(), name, 'node_modules', pkg)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0' }))
}

describe('scanPluginUsages', () => {
  it('finds a declared file: dependency and carries the dsh id', () => {
    mkProfile('p1', { dependencies: { '@me/plugin': 'file:C:\\store\\p' } })
    const found = scanPluginUsages([scope('d')], '@me/plugin')
    expect(found).toHaveLength(1)
    expect(found[0]!.usage).toMatchObject({
      dsh: 'dsh@d', dshId: 'd', dshVersion: '9.0.0', profile: 'p1', spec: 'file:C:\\store\\p',
    })
    expect(found[0]!.spec).toBe('file:C:\\store\\p')
    expect(found[0]!.inBundles).toBe(false)
  })

  it('finds a bundle-layer row that declares no dependency spec', () => {
    mkProfile('p1', { dsh: { profile: { bundles: ['@me/plugin'] } } })
    const found = scanPluginUsages([scope('d')], '@me/plugin')
    expect(found).toHaveLength(1)
    expect(found[0]!.inBundles).toBe(true)
    // A bundle row alone is a reference even though nothing resolves yet.
    expect(found[0]!.usage.spec).toBeUndefined()
  })

  it('finds a leftover node_modules entry the manifest no longer mentions', () => {
    // The Windows case that matters: the manifest was cleared but the junction
    // still pins the store archive, so a full uninstall has to see this profile.
    mkProfile('p1', { dependencies: {} })
    mkInstalled('p1', '@me/plugin')
    const found = scanPluginUsages([scope('d')], '@me/plugin')
    expect(found).toHaveLength(1)
    expect(found[0]!.nmStat?.isDirectory()).toBe(true)
    expect(found[0]!.usage.spec).toBeUndefined()
  })

  it('finds a DANGLING junction, which existsSync reports as absent', () => {
    mkProfile('p1', { dependencies: {} })
    const target = join(root, 'gone-target')
    mkdirSync(target, { recursive: true })
    const nm = join(profiles(), 'p1', 'node_modules')
    // A scoped name nests, so the scope directory itself must exist first.
    mkdirSync(join(nm, '@me'), { recursive: true })
    symlinkSync(target, join(nm, '@me', 'plugin'), 'junction')
    rmSync(target, { recursive: true, force: true })
    expect(scanPluginUsages([scope('d')], '@me/plugin')).toHaveLength(1)
  })

  it('ignores profiles that never reference the plugin', () => {
    mkProfile('p1', { dependencies: { other: '^1.0.0' } })
    mkProfile('p2', { dsh: { profile: { bundles: ['other'] } } })
    expect(scanPluginUsages([scope('d')], '@me/plugin')).toEqual([])
  })

  it('does not count a plain registry range as a store reference', () => {
    // The launcher installs from the store with an absolute `file:` spec. A
    // registry range means pnpm resolves the package from npm, which is a
    // different source: detaching it would break an install nobody asked to move.
    mkProfile('p1', { dependencies: { '@me/plugin': '^1.0.0' } })
    expect(scanPluginUsages([scope('d')], '@me/plugin')).toEqual([])
  })

  it('skips an unreadable manifest and still scans the next profile', () => {
    const bad = join(profiles(), 'broken')
    mkdirSync(bad, { recursive: true })
    writeFileSync(join(bad, 'package.json'), '{ not json')
    mkProfile('p1', { dependencies: { '@me/plugin': 'file:/store/plugin' } })
    const found = scanPluginUsages([scope('d')], '@me/plugin')
    expect(found.map(item => item.usage.profile)).toEqual(['p1'])
  })

  it('scans every dsh scope and keys the selector by dsh NAME', () => {
    const otherHome = join(root, 'home2')
    mkdirSync(join(otherHome, 'profiles', 'p2'), { recursive: true })
    writeFileSync(join(otherHome, 'profiles', 'p2', 'package.json'), JSON.stringify({ dependencies: { '@me/plugin': 'file:/store/two' } }))
    mkProfile('p1', { dependencies: { '@me/plugin': 'file:/store/one' } })
    const dshes = [scope('a'), scope('b', 'dsh@b', otherHome)]
    expect(pluginsUsing(dshes, '@me/plugin').map(u => `${u.dshId}:${u.profile}`)).toEqual(['a:p1', 'b:p2'])
    expect(scanPluginUsages(dshes, '@me/plugin', { only: (dshName, profile) => dshName === 'dsh@b' && profile === 'p2' }))
      .toHaveLength(1)
  })

  it('reports nothing for a home without a profiles directory', () => {
    expect(pluginsUsing([scope('d', 'dsh@d', join(root, 'no-home'))], '@me/plugin')).toEqual([])
  })
})
