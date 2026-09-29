/**
 * Sub-bundle resolution for aggregate plugins: enumerating the sub-packages a
 * bundle's patch references, resolving each to its on-disk dir, and producing the
 * `link:` mappings the install side writes into a profile. Pure FS, no pnpm.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { bundleSubdepLinks, listBundleSubdepNames, resolveBundleSubdepDir } from './subdeps.ts'

let root: string
let aggr: string // aggregate bundle真身: <root>/node_modules/@sc/aggr
const subDir = (name: string): string => join(root, 'node_modules', name)

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-subdeps-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => { rmSync(root, { recursive: true, force: true }) })

/** Build an aggregate bundle真身 (+ its patch + sub-siblings) at `aggr`. */
function buildAggr(patch: string): void {
  aggr = join(root, 'node_modules', 'aggr')
  mkdirSync(aggr, { recursive: true })
  writeFileSync(join(aggr, 'package.json'),
    JSON.stringify({ name: 'aggr', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(aggr, 'cordis.patch.yml'), patch)
}

function mkSub(name: string): void { mkdirSync(subDir(name), { recursive: true }); writeFileSync(join(subDir(name), 'package.json'), JSON.stringify({ name, version: '1.0.0' })) }

const patchWith = (rows: string[]): string =>
  rows.map((name) => `- insert:\n    - id: row-${name}\n      name: '${name}'\n`).join('')

describe('listBundleSubdepNames', () => {
  it('returns the distinct name-bearing rows, excluding the bundle itself', () => {
    buildAggr(patchWith(['sub-a', 'sub-b', 'sub-a', 'aggr']))
    mkSub('sub-a'); mkSub('sub-b')
    expect(listBundleSubdepNames(aggr)).toEqual(['sub-a', 'sub-b'])
  })

  it('returns [] for a bundle with no patch or no name rows', () => {
    // No patch file → empty
    aggr = join(root, 'node_modules', 'aggr-empty')
    mkdirSync(aggr, { recursive: true })
    writeFileSync(join(aggr, 'package.json'), JSON.stringify({ name: 'aggr-empty', dsh: { bundle: { patch: 'x.patch' } } }))
    expect(listBundleSubdepNames(aggr)).toEqual([])
    // No dsh.bundle declared → empty
    const plain = join(root, 'node_modules', 'plain')
    mkdirSync(plain, { recursive: true })
    writeFileSync(join(plain, 'package.json'), JSON.stringify({ name: 'plain' }))
    expect(listBundleSubdepNames(plain)).toEqual([])
  })

  it('tolerates an unreadable patch', () => {
    aggr = join(root, 'node_modules', 'aggr-bad')
    mkdirSync(aggr, { recursive: true })
    writeFileSync(join(aggr, 'package.json'), JSON.stringify({ name: 'aggr-bad', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(aggr, 'cordis.patch.yml'), 'not: [valid: yaml')
    expect(listBundleSubdepNames(aggr)).toEqual([])
  })

  // `dsh.bundle.patch` may be an ordered LIST, and 0.2.0-rc.1's web-app bundle uses
  // that form. Handing the list to `path.join` threw a TypeError straight out of
  // the install / uninstall / installed-overview callers.
  it('reads every patch file a bundle declares, not only the first', () => {
    aggr = join(root, 'node_modules', 'aggr-multi')
    mkdirSync(join(aggr, 'presets'), { recursive: true })
    writeFileSync(join(aggr, 'package.json'), JSON.stringify({
      name: 'aggr-multi',
      dsh: { bundle: { patch: ['./cordis.patch.yml', './presets/standard.patch.yml'] } },
    }))
    writeFileSync(join(aggr, 'cordis.patch.yml'), "- insert:\n    - id: row-a\n      name: 'sub-a'\n")
    writeFileSync(join(aggr, 'presets', 'standard.patch.yml'), "- insert:\n    - id: row-b\n      name: 'sub-b'\n")
    expect(listBundleSubdepNames(aggr)).toEqual(['sub-a', 'sub-b'])
  })

  it('keeps the declared files that are present when one is missing', () => {
    aggr = join(root, 'node_modules', 'aggr-gap')
    mkdirSync(aggr, { recursive: true })
    writeFileSync(join(aggr, 'package.json'), JSON.stringify({
      name: 'aggr-gap',
      dsh: { bundle: { patch: ['./gone.patch.yml', './cordis.patch.yml'] } },
    }))
    writeFileSync(join(aggr, 'cordis.patch.yml'), "- insert:\n    - id: row-a\n      name: 'sub-a'\n")
    expect(listBundleSubdepNames(aggr)).toEqual(['sub-a'])
  })
})

describe('resolveBundleSubdepDir / bundleSubdepLinks', () => {
  it('resolves a sibling sub-package from the aggregate anchor', () => {
    buildAggr(patchWith(['sub-a']))
    mkSub('sub-a')
    expect(resolveBundleSubdepDir(aggr, 'sub-a')).toBe(subDir('sub-a'))
  })

  it('returns the link mappings for installed sub-packages only', () => {
    buildAggr(patchWith(['sub-a', 'sub-missing']))
    mkSub('sub-a')
    expect(bundleSubdepLinks(aggr)).toEqual([{ name: 'sub-a', dir: subDir('sub-a') }])
  })
})