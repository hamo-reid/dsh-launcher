/**
 * Model detection and the profile-layer adapter: which preset model a profile's
 * patch stack mounts, and the layers its roster is read from.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextForEntry } from '../profile/appState.ts'
import { detectModel, profileLayers } from './layers.ts'
import type { ComposedLayer } from './declaration.ts'

let root: string
const home = (): string => join(root, 'home')
const profiles = (): string => join(home(), 'profiles')
const ctx = (): ReturnType<typeof contextForEntry> =>
  contextForEntry({ id: 'a', name: 'dsh@a', execPath: '/fake/a', version: 'a', home: home() })

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-preset-layers-')) })

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(profiles(), { recursive: true })
})

/** A profile with a bundle list and, when given, a patch body. */
function mkProfile(name: string, bundles: string[] = []): string {
  const dir = join(profiles(), name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }))
  return dir
}

/** A bundle layer in the profile's own node_modules. */
function mkBundle(profile: string, bundle: string, patches: Record<string, string>): void {
  const dir = join(profiles(), profile, 'node_modules', bundle)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { bundle: { patch: Object.keys(patches) } } }))
  for (const [rel, text] of Object.entries(patches)) {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
}

const layerOf = (kind: ComposedLayer['kind'], text: string): ComposedLayer => ({
  kind, text, path: `C:/x/${kind}.patch.yml`, baseDir: `C:/x/${kind}`,
})

describe('detectModel', () => {
  it('reads the declaration model off the declaration plugin row', () => {
    expect(detectModel([layerOf('bundle', "- insert:\n    - id: preset-a\n      name: '@deepseek-ai/dsh-agent-preset'\n")]))
      .toBe('declaration')
  })

  it('reads it off the registry row alone', () => {
    expect(detectModel([layerOf('bundle', "- insert:\n    - id: agent-preset-registry\n      name: '@deepseek-ai/dsh-agent-preset-registry'\n")]))
      .toBe('declaration')
  })

  it('reads the directory model off the old preset package row', () => {
    expect(detectModel([layerOf('bundle', "- insert:\n    - id: agent-presets\n      name: '@deepseek-ai/dsh-agent-presets'\n")]))
      .toBe('directory')
  })

  it('prefers the declaration model when a deployment carries both', () => {
    const layers = [
      layerOf('bundle', "- id: agent-presets\n  name: '@deepseek-ai/dsh-agent-presets'\n"),
      layerOf('profile', "- id: agent-preset-registry\n  name: '@deepseek-ai/dsh-agent-preset-registry'\n"),
    ]
    expect(detectModel(layers)).toBe('declaration')
    expect(detectModel([...layers].reverse())).toBe('declaration')
  })

  it('reports none when nothing mounts a roster', () => {
    expect(detectModel([])).toBe('none')
    expect(detectModel([layerOf('bundle', "- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n")])).toBe('none')
  })

  // A declaration's own plugin list can name anything, including a package whose
  // name merely starts like one of these.
  it('is not fooled by a plugin row nested inside a declaration', () => {
    const nested = [
      '- insert:',
      '    - id: local-preset-x',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: x',
      '        plugins:',
      '          - id: helper',
      "            name: '@deepseek-ai/dsh-agent-preset-helper'",
      '',
    ].join('\n')
    expect(detectModel([layerOf('profile', nested)])).toBe('declaration')
    expect(detectModel([layerOf('profile', nested.replace("'@deepseek-ai/dsh-agent-preset'", "'@deepseek-ai/dsh-persona'"))]))
      .toBe('none')
  })
})

describe('profileLayers', () => {
  it('reads every patch file a bundle declares, then the profile, then the home', () => {
    mkProfile('p', ['b'])
    mkBundle('p', 'b', { 'cordis.patch.yml': '- id: base\n', 'presets/standard.patch.yml': '- id: std\n' })
    writeFileSync(join(profiles(), 'p', 'cordis.patch.yml'), '- id: mine\n')
    writeFileSync(join(home(), 'cordis.patch.yml'), '- id: shared\n')

    const layers = profileLayers(ctx(), 'p')
    expect(layers.map(l => l.kind)).toEqual(['bundle', 'bundle', 'profile', 'home'])
    expect(layers.map(l => l.path.split(/[\\/]/).slice(-2).join('/'))).toEqual([
      'b/cordis.patch.yml', 'presets/standard.patch.yml',
      'p/cordis.patch.yml', 'home/cordis.patch.yml',
    ])
    // The base a `.`-relative row resolves against is the declaring file's dir.
    expect(layers[1].baseDir).toBe(join(profiles(), 'p', 'node_modules', 'b', 'presets'))
    expect(layers[0].bundle).toBe('b')
    expect(layers[2].bundle).toBeUndefined()
    expect(detectModel(layers)).toBe('none')
  })

  it('omits the profile layer when its patch is blank, and finds the model', () => {
    mkProfile('p', ['b'])
    mkBundle('p', 'b', { 'cordis.patch.yml': "- id: agent-presets\n  name: '@deepseek-ai/dsh-agent-presets'\n" })
    writeFileSync(join(profiles(), 'p', 'cordis.patch.yml'), '   \n')
    const layers = profileLayers(ctx(), 'p')
    expect(layers.map(l => l.kind)).toEqual(['bundle'])
    expect(detectModel(layers)).toBe('directory')
  })
})
