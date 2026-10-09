/**
 * What a preset row offers, and the reason it may offer less.
 *
 * Two claims that cannot be rendered in this repo's tests: the kebab menu is an
 * antd `Dropdown` (a portal — its items are absent from a server render) and the
 * reason is a `Tooltip` (rendered on hover). The decisions themselves are pure,
 * so they are asserted directly — see `docs/TESTING.md` §4.
 */
import { describe, expect, it } from 'vitest'
import { presetReadOnlyHintKey, presetRowActions } from './presetRow.ts'

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
