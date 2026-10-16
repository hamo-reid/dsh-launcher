/**
 * Layer labelling and issue counting for the profile workspace.
 *
 * `lastSeenByRow`'s order is the subtle one: it decides which layer — and, for a
 * bundle composing several patch files, which FILE — a row appears to come from,
 * and getting the walk backwards would silently relabel every row in the patch list.
 */
import { describe, expect, it } from 'vitest'
import {
  fileLabel, fileNameLabel, issueCount, layerRowEntries, lastSeenByRow, layerLabel, layerRowCount, rowActionsOf,
  rowMatchesQuery,
} from './profileLayers.ts'
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

describe('layerRowEntries', () => {
  it('flattens a single-file layer in order, with no file qualifier', () => {
    const entries = layerRowEntries(layer('profile', ['a', 'b'], { label: 'hamo' }))
    expect(entries.map(e => e.row.id)).toEqual(['a', 'b'])
    expect(entries.map(e => e.file)).toEqual([undefined, undefined])
  })

  it('keeps each row with the file of its bundle, in application order', () => {
    const entries = layerRowEntries(multiLayer('web', [['cordis.patch.yml', ['a']], ['presets/standard.patch.yml', ['b']]]))
    expect(entries.map(e => [e.file, e.row.id])).toEqual([
      ['cordis.patch.yml', 'a'],
      ['presets/standard.patch.yml', 'b'],
    ])
  })

  // The pane is driven by this key: two rows sharing one would select together.
  it('gives one id declared by two files two distinct keys', () => {
    const entries = layerRowEntries(multiLayer('web', [['a.yml', ['web']], ['b.yml', ['web']]]))
    expect(new Set(entries.map(e => e.key)).size).toBe(2)
  })

  it('gives an id repeated inside one file two distinct keys', () => {
    const entries = layerRowEntries(layer('profile', ['web', 'web'], { label: 'hamo' }))
    expect(entries.map(e => e.row.id)).toEqual(['web', 'web'])
    expect(new Set(entries.map(e => e.key)).size).toBe(2)
  })

  it('is empty for a layer with no rows', () => {
    expect(layerRowEntries(layer('home', []))).toEqual([])
  })
})

describe('fileNameLabel', () => {
  it('matches the file label of the file it names', () => {
    const many = multiLayer('web', [['a.yml', ['a']], ['b.yml', ['b']]])
    expect(fileNameLabel(many, 'b.yml')).toEqual(fileLabel(many, many.files[1]))
  })

  it('is the layer\'s own label for a single-file layer', () => {
    const one = layer('bundle', ['a'], { bundle: 'base' })
    expect(fileNameLabel(one, undefined)).toEqual({ key: 'profile.layer.bundle', options: { name: 'base' } })
  })
})

describe('rowActionsOf', () => {
  it('lets a bundle row be covered, and nothing else', () => {
    expect(rowActionsOf({ source: 'bundle', bundle: 'base' }))
      .toEqual({ canToggle: false, canCover: true, canEdit: false, canDelete: false })
  })

  it('offers nothing when a bundle layer carries no package name', () => {
    // The cover write needs a bundle to copy FROM, so the action is unavailable.
    expect(rowActionsOf({ source: 'bundle' })).toEqual({ canToggle: false, canCover: false, canEdit: false, canDelete: false })
  })

  it('lets a home row be toggled, and nothing else', () => {
    expect(rowActionsOf({ source: 'home' })).toEqual({ canToggle: true, canCover: false, canEdit: false, canDelete: false })
  })

  it('lets the profile\'s own row be edited and dropped', () => {
    expect(rowActionsOf({ source: 'profile' })).toEqual({ canToggle: true, canCover: false, canEdit: true, canDelete: true })
  })
})

describe('rowMatchesQuery', () => {
  const named = (over: Partial<ClassifiedRow> = {}): ClassifiedRow =>
    ({ id: 'web-ui', name: 'Web UI', disabled: false, hasConfig: false, hasInsert: false, ...over })

  it('matches a blank query, so clearing the box restores the layer', () => {
    expect(rowMatchesQuery(named(), '')).toBe(true)
    expect(rowMatchesQuery(named(), '   ')).toBe(true)
  })

  it('matches the id even when the row displays a name', () => {
    // The id is what the patch file spells and what the tags name.
    expect(rowMatchesQuery(named(), 'web-ui')).toBe(true)
  })

  it('matches the display name, case-insensitively', () => {
    expect(rowMatchesQuery(named(), 'web ui')).toBe(true)
    expect(rowMatchesQuery(named(), 'WEB')).toBe(true)
  })

  it('does not match a row that has neither', () => {
    expect(rowMatchesQuery(named(), 'timer')).toBe(false)
    expect(rowMatchesQuery(named({ name: undefined }), 'web ui')).toBe(false)
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
