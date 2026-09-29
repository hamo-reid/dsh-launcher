/**
 * Layer labelling and issue counting for the profile workspace.
 *
 * `lastSeenByRow`'s order is the subtle one: it decides which layer — and, for a
 * bundle composing several patch files, which FILE — a row appears to come from,
 * and getting the walk backwards would silently relabel every row in the patch list.
 */
import { describe, expect, it } from 'vitest'
import { fileLabel, issueCount, lastSeenByRow, layerLabel, layerRowCount } from './profileLayers.ts'
import type { ClassifiedRow, InsertConflict, ProfileLayer, ProfileValidation } from '../../../shared/types.ts'

const row = (id: string): ClassifiedRow => ({ id, disabled: false, hasConfig: false, hasInsert: false })
const layer = (source: ProfileLayer['source'], ids: string[], extra: Partial<ProfileLayer> = {}): ProfileLayer =>
  ({ source, files: [{ rows: ids.map(row) }], ...extra })
/** A bundle layer whose files each carry their own qualifier and rows. */
const multiLayer = (bundle: string, files: [string, string[]][]): ProfileLayer =>
  ({ source: 'bundle', bundle, files: files.map(([file, ids]) => ({ file, rows: ids.map(row) })) })

describe('layerLabel', () => {
  it('names a bundle layer by its package', () => {
    expect(layerLabel({ source: 'bundle', bundle: '@deepseek-ai/dsh-base' }))
      .toEqual({ key: 'profile.layer.bundle', options: { name: '@deepseek-ai/dsh-base' } })
  })

  // A bundle composing several patch files is only distinguishable by the file, so
  // the qualifier is part of its identity — labels are compared as TEXT.
  it('qualifies a bundle layer by its file when its bundle declares several', () => {
    expect(layerLabel({ source: 'bundle', bundle: 'web', file: 'presets/standard.patch.yml' }))
      .toEqual({ key: 'profile.layer.bundleFile', options: { name: 'web', file: 'presets/standard.patch.yml' } })
  })

  it('ignores an empty file qualifier rather than labelling with one', () => {
    expect(layerLabel({ source: 'bundle', bundle: 'web', file: '' }))
      .toEqual({ key: 'profile.layer.bundle', options: { name: 'web' } })
  })

  it('names a profile layer by its label', () => {
    expect(layerLabel({ source: 'profile', label: 'hamo' }))
      .toEqual({ key: 'profile.layer.profile', options: { name: 'hamo' } })
  })

  it('names a bare patch overlay — the case only a conflict list reaches', () => {
    expect(layerLabel({ source: 'patch', label: 'extra.yml' }))
      .toEqual({ key: 'profile.detail.patchLayer', options: { name: 'extra.yml' } })
  })

  it('falls back to the home layer, which carries no name', () => {
    expect(layerLabel({ source: 'home' })).toEqual({ key: 'profile.layer.home' })
  })

  it('substitutes an empty name rather than leaving the param undefined', () => {
    expect(layerLabel({ source: 'bundle' })).toEqual({ key: 'profile.layer.bundle', options: { name: '' } })
  })
})

describe('fileLabel / layerRowCount', () => {
  it('labels a file with its layer\'s identity, so one file changes nothing', () => {
    const one = layer('bundle', ['a'], { bundle: 'base' })
    expect(fileLabel(one, one.files[0])).toEqual({ key: 'profile.layer.bundle', options: { name: 'base' } })
  })

  it('labels each file of a multi-file bundle distinctly', () => {
    const many = multiLayer('web', [['cordis.patch.yml', ['a']], ['presets/standard.patch.yml', ['b']]])
    expect(many.files.map(f => fileLabel(many, f))).toEqual([
      { key: 'profile.layer.bundleFile', options: { name: 'web', file: 'cordis.patch.yml' } },
      { key: 'profile.layer.bundleFile', options: { name: 'web', file: 'presets/standard.patch.yml' } },
    ])
  })

  it('counts rows across every file of a layer', () => {
    expect(layerRowCount(multiLayer('web', [['a.yml', ['x', 'y']], ['b.yml', ['z']]]))).toBe(3)
    expect(layerRowCount(layer('home', []))).toBe(0)
  })
})

describe('lastSeenByRow', () => {
  it('attributes a row to the LAST layer that mentions it', () => {
    // Outermost-first, so `home` outranks `profile`, which outranks the bundle.
    const layers = [
      layer('bundle', ['web', 'timer'], { bundle: 'base' }),
      layer('profile', ['web'], { label: 'hamo' }),
      layer('home', ['web']),
    ]
    const seen = lastSeenByRow(layers)
    expect(seen.get('web')).toEqual({ key: 'profile.layer.home' })
    expect(seen.get('timer')).toEqual({ key: 'profile.layer.bundle', options: { name: 'base' } })
  })

  it('keeps a row only its outermost layer holds', () => {
    const seen = lastSeenByRow([
      layer('bundle', ['only-bundle'], { bundle: 'base' }),
      layer('home', ['other']),
    ])
    expect(seen.get('only-bundle')).toEqual({ key: 'profile.layer.bundle', options: { name: 'base' } })
  })

  // Within one layer the later file wins, exactly as it does across layers: dsh
  // applies the files in declared order. The row is attributed to that file, which
  // is what the override tag has to name.
  it('attributes a row to the later of two files of one bundle', () => {
    const seen = lastSeenByRow([
      layer('home', ['web']),
      multiLayer('web', [['cordis.patch.yml', ['web', 'shell']], ['presets/standard.patch.yml', ['web']]]),
    ])
    expect(seen.get('web')).toEqual({ key: 'profile.layer.bundleFile', options: { name: 'web', file: 'presets/standard.patch.yml' } })
    expect(seen.get('shell')).toEqual({ key: 'profile.layer.bundleFile', options: { name: 'web', file: 'cordis.patch.yml' } })
  })

  it('is empty for no layers', () => {
    expect(lastSeenByRow([]).size).toBe(0)
  })
})

describe('issueCount', () => {
  const valid: ProfileValidation = {
    ok: true, conflicts: [], missingBundles: [], unclaimedBundles: [],
  }

  it('counts nothing for a clean profile', () => {
    expect(issueCount([], valid)).toBe(0)
  })

  it('counts each finding of the validation run', () => {
    expect(issueCount([], { ...valid, manifestError: 'bad json' })).toBe(1)
    expect(issueCount([], { ...valid, patchError: 'bad yaml' })).toBe(1)
    expect(issueCount([], { ...valid, missingBundles: ['a', 'b'] })).toBe(2)
    expect(issueCount([], { ...valid, unclaimedBundles: ['c'] })).toBe(1)
    expect(issueCount([], {
      ...valid, manifestError: 'x', patchError: 'y', missingBundles: ['a'], unclaimedBundles: ['b'],
    })).toBe(4)
  })

  it('counts the boot-blocking conflicts too, and works before a validation ran', () => {
    const conflicts = [{ id: 'web', layers: [] }, { id: 'ws', layers: [] }] as InsertConflict[]
    expect(issueCount(conflicts, valid)).toBe(2)
    expect(issueCount(conflicts, null)).toBe(2)
    expect(issueCount([], null)).toBe(0)
  })
})
