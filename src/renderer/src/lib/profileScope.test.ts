/** The profile a page scopes its listing to — the rule both pages share. */
import { describe, it, expect } from 'vitest'
import { nextProfileChoice } from './profileScope.ts'

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
