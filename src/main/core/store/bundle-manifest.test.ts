/**
 * The one reader of a bundle's `dsh.bundle.patch` declaration. dsh accepts one
 * path or an ordered list of paths, and every consumer that re-derived the
 * declaration got the list form wrong in its own way — so these lock both shapes,
 * the filename fallback and the drop-the-missing rule.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { bundlePatchPaths, bundlePatchRels, declaredBundlePatches } from './bundle-manifest.ts'

let root: string
let dir: string

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-bundle-manifest-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  dir = join(root, 'pkg')
  mkdirSync(dir, { recursive: true })
})

/** Write the package manifest's `dsh.bundle` value verbatim. */
function manifestWith(bundle: unknown): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg', dsh: { bundle } }))
}

describe('declaredBundlePatches', () => {
  it('reads a single declared path', () => {
    manifestWith({ patch: './custom.patch.yml' })
    expect(declaredBundlePatches(dir)).toEqual(['./custom.patch.yml'])
  })

  it('reads an ordered list, dropping entries that are not usable paths', () => {
    manifestWith({ patch: ['./a.yml', '', 42, './b.yml'] })
    expect(declaredBundlePatches(dir)).toEqual(['./a.yml', './b.yml'])
  })

  it('declares nothing for an empty string, a wrong type or no bundle at all', () => {
    manifestWith({ patch: '   ' })
    expect(declaredBundlePatches(dir)).toEqual([])
    manifestWith({ patch: { file: 'x' } })
    expect(declaredBundlePatches(dir)).toEqual([])
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg' }))
    expect(declaredBundlePatches(dir)).toEqual([])
  })

  it('declares nothing when the manifest is missing or unreadable', () => {
    expect(declaredBundlePatches(join(root, 'absent'))).toEqual([])
    writeFileSync(join(dir, 'package.json'), 'not json')
    expect(declaredBundlePatches(dir)).toEqual([])
  })
})

describe('bundlePatchRels / bundlePatchPaths', () => {
  it('falls back to the historical filename when nothing is declared', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg' }))
    expect(bundlePatchRels(dir)).toEqual(['cordis.patch.yml'])
  })

  it('resolves the declared files that exist, in declared order', () => {
    manifestWith({ patch: ['./cordis.patch.yml', './presets/standard.patch.yml'] })
    mkdirSync(join(dir, 'presets'), { recursive: true })
    writeFileSync(join(dir, 'presets', 'standard.patch.yml'), '- insert: []\n')
    expect(bundlePatchPaths(dir)).toEqual([join(dir, 'presets', 'standard.patch.yml')])
  })
})
