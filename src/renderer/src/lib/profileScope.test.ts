/** The profile a page scopes its listing to — the rule both pages share. */
import { describe, it, expect } from 'vitest'
import {
  canReaskProfile, nextProfileChoice, profileScope, scopeNames, scopeProfile, type ProfileScope,
} from './profileScope.ts'

describe('nextProfileChoice', () => {
  it('keeps the remembered profile while it still exists', () => {
    expect(nextProfileChoice('beta', ['alpha', 'beta'])).toBe('beta')
  })

  it('falls back to the first profile when the remembered one is gone or unset', () => {
    expect(nextProfileChoice(undefined, ['alpha', 'beta'])).toBe('alpha')
    // A profile deleted (or renamed) since the page last loaded must not stick.
    expect(nextProfileChoice('removed', ['alpha', 'beta'])).toBe('alpha')
  })

  it('is undefined for a dsh with no profiles — the machine-level view', () => {
    // Not "no answer": the panel lists the dsh's own roots and says that the
    // preset-contributed ones need a profile.
    expect(nextProfileChoice(undefined, [])).toBeUndefined()
    expect(nextProfileChoice('stale', [])).toBeUndefined()
  })
})

describe('profileScope', () => {
  it('tags the names with the dsh that answered, and remembers across a switch', () => {
    // The remembered NAME may cross a dsh switch — the claim that the other dsh
    // has it (`names`) is what gets re-read.
    expect(profileScope('b', ['base-web'], 'hamo-studio').chosen).toBe('base-web')
    expect(profileScope('b', ['base-web', 'hamo-studio'], 'hamo-studio').chosen).toBe('hamo-studio')
    expect(profileScope('b', [], 'hamo-studio')).toMatchObject({ dshId: 'b', names: [], chosen: undefined })
  })
})

describe('scopeProfile / scopeNames', () => {
  const other: ProfileScope = { dshId: 'a', names: ['hamo-studio'], chosen: 'hamo-studio' }

  it('answers nothing for a dsh the scope was not read from', () => {
    // The defect this replaces: a page that switched dsh asked the new one about
    // the old one's profile, and core refused it (profile.notFound) — one error
    // toast and one wasted listing per switch.
    expect(scopeProfile(other, 'b')).toBeUndefined()
    expect(scopeNames(other, 'b')).toEqual([])
  })

  it('answers for the dsh it was read from, and for no dsh at all', () => {
    expect(scopeProfile(other, 'a')).toBe('hamo-studio')
    expect(scopeNames(other, 'a')).toEqual(['hamo-studio'])
    // Nothing selected yet / nothing read yet: an empty scope is the only answer,
    // never another dsh's names.
    expect(scopeProfile(null, 'a')).toBeUndefined()
    expect(scopeNames(null, 'a')).toEqual([])
    expect(scopeProfile(other, undefined)).toBeUndefined()
    expect(scopeNames(other, undefined)).toEqual([])
  })
})

describe('canReaskProfile', () => {
  it('re-asks when the refused name is one the dsh no longer has', () => {
    // The dsh's home moved, or the profile was deleted / renamed while the page
    // stayed open: re-reading the list changes the choice, so the page asks again
    // instead of reporting a refusal it caused itself.
    expect(canReaskProfile('hamo-studio', ['base-web', 'test'])).toBe(true)
    expect(canReaskProfile('hamo-studio', [])).toBe(true)
  })

  it('reports when the name is still listed — that refusal is real', () => {
    expect(canReaskProfile('hamo-studio', ['hamo-studio', 'test'])).toBe(false)
  })
})
