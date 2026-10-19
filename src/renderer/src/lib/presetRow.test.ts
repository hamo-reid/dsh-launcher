/**
 * What a preset row offers, the reason it may offer less, how one preset's own
 * rows are grouped and labelled when they are listed, and what the page header
 * says about the whole roster.
 *
 * Claims that cannot be rendered in this repo's tests: the kebab menu is an antd
 * `Dropdown` (a portal — its items are absent from a server render) and the reason
 * is a `Tooltip` (rendered on hover). The decisions themselves are pure, so they
 * are asserted directly — see `docs/TESTING.md` §4.
 */
import { describe, expect, it } from 'vitest'
import {
  presetGradeColour, presetGradeLabel, presetReadOnlyHintKey, presetRosterSummary, presetRowActions,
  presetRowSections,
} from './presetRow.ts'
import type { PresetCompositionRow, PresetGrade } from '../../../shared/types.ts'

describe('presetRowActions', () => {
  it('offers all three actions on a preset this page writes', () => {
    expect(presetRowActions({ editable: true })).toEqual(['edit', 'copy', 'delete'])
  })

  it('keeps only the copy on one it does not', () => {
    // A copy lands in the profile's own layer, so it is legal from any source —
    // every other entry would write where the page may not.
    expect(presetRowActions({ editable: false })).toEqual(['copy'])
  })
})

describe('presetReadOnlyHintKey', () => {
  it('says nothing about a row that is editable', () => {
    expect(presetReadOnlyHintKey({ editable: true, source: 'profile' })).toBeUndefined()
  })

  it('names the deployment for a bundled one, and the home layer for a home one', () => {
    expect(presetReadOnlyHintKey({ editable: false, source: 'bundle' })).toBe('preset.readOnlyHint')
    expect(presetReadOnlyHintKey({ editable: false, source: 'package' })).toBe('preset.readOnlyHint')
    // Not the built-in wording: a home-layer declaration is the person's own, so
    // "copy it first" would name the wrong cause and the wrong fix.
    expect(presetReadOnlyHintKey({ editable: false, source: 'home' })).toBe('preset.homeReadOnlyHint')
  })
})

describe('presetRowSections', () => {
  const row = (state: PresetCompositionRow['state'], name: string = state): PresetCompositionRow =>
    ({ label: `row "${name}"`, name, kind: 'package', state })

  it('reads a problem before a working row', () => {
    const sections = presetRowSections([row('found'), row('skipped'), row('conditional'), row('missing')])
    expect(sections.map(section => section.state)).toEqual(['missing', 'conditional', 'skipped', 'found'])
  })

  it('leaves out a state the preset has no row in', () => {
    expect(presetRowSections([row('found')]).map(section => section.state)).toEqual(['found'])
    expect(presetRowSections([])).toEqual([])
  })

  it('keeps composition order inside a section, count included', () => {
    const sections = presetRowSections([row('found', 'a'), row('missing', 'x'), row('found', 'b'), row('missing', 'y')])
    expect(sections.map(section => [section.state, section.rows.map(r => r.name)])).toEqual([
      ['missing', ['x', 'y']],
      ['found', ['a', 'b']],
    ])
  })
})

describe('presetGradeLabel / presetGradeColour', () => {
  const cell = (over: Partial<PresetGrade> = {}): PresetGrade => ({
    presetId: 'standard', profile: 'alpha', level: 'ok', checked: 0, skipped: 0, conditional: 0, missing: [], rows: [], ...over,
  })

  it('leads an incomplete grade with the count, which is what the tag is for', () => {
    expect(presetGradeLabel(cell({ level: 'incomplete', missing: [{ label: 'row 1', name: '@acme/x' }] })))
      .toEqual({ key: 'preset.grade.incomplete', options: { count: 1 } })
  })

  it('says so when there is no grade at all', () => {
    expect(presetGradeLabel(undefined)).toEqual({ key: 'preset.grade.unknown' })
    expect(presetGradeColour(undefined)).toBe('default')
  })

  it('maps each level to its own tag colour', () => {
    expect(presetGradeColour(cell())).toBe('success')
    expect(presetGradeColour(cell({ level: 'incomplete' }))).toBe('warning')
    expect(presetGradeColour(cell({ level: 'unusable', reason: 'x' }))).toBe('error')
  })
})

describe('presetRosterSummary', () => {
  const cell = (level: PresetGrade['level']): PresetGrade => ({
    presetId: 'x', profile: 'alpha', level, checked: 0, skipped: 0, conditional: 0, missing: [], rows: [],
  })

  it('says how many there are and that all of them work', () => {
    // The four state counts would all read zero here: the tally a person wants is
    // the one that fits in one word.
    expect(presetRosterSummary([cell('ok'), cell('ok')]))
      .toEqual([{ key: 'preset.head.count', options: { count: 2 } }, { key: 'preset.head.allOk' }])
  })

  it('counts each level, worst first, and leaves out the zeroes', () => {
    expect(presetRosterSummary([cell('ok'), cell('ok'), cell('unusable'), cell('incomplete')])).toEqual([
      { key: 'preset.head.count', options: { count: 4 } },
      { key: 'preset.head.ok', options: { count: 2 } },
      { key: 'preset.head.unusable', options: { count: 1 } },
      { key: 'preset.head.incomplete', options: { count: 1 } },
    ])
  })

  it('counts a roster with no working preset without inventing an "ok 0"', () => {
    expect(presetRosterSummary([cell('unusable'), cell('incomplete')])).toEqual([
      { key: 'preset.head.count', options: { count: 2 } },
      { key: 'preset.head.unusable', options: { count: 1 } },
      { key: 'preset.head.incomplete', options: { count: 1 } },
    ])
  })

  it('says a preset the page could not judge is ungraded, not fine', () => {
    expect(presetRosterSummary([cell('ok'), undefined])).toEqual([
      { key: 'preset.head.count', options: { count: 2 } },
      { key: 'preset.head.ok', options: { count: 1 } },
      { key: 'preset.head.unknown', options: { count: 1 } },
    ])
  })

  it('leaves the header with nothing to say about an empty roster', () => {
    // The empty state below the header is the answer there; "0 preset(s)" above it
    // would only repeat it.
    expect(presetRosterSummary([])).toEqual([])
  })
})
