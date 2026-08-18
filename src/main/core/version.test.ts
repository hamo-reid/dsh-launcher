/** Tests for the lightweight semver `satisfiesRange` used to decide store reuse. */
import { describe, it, expect } from 'vitest'
import { satisfiesRange, parseVersion } from './version.ts'

describe('satisfiesRange', () => {
  it('matches exact versions', () => {
    expect(satisfiesRange('0.8.0', '0.8.0')).toBe(true)
    expect(satisfiesRange('0.8.0', '0.8.1')).toBe(false)
  })

  it('treats empty / * / latest as any', () => {
    expect(satisfiesRange('1.2.3', '')).toBe(true)
    expect(satisfiesRange('1.2.3', '*')).toBe(true)
    expect(satisfiesRange('2.0.1', 'latest')).toBe(true)
  })

  it('handles caret ranges within the major', () => {
    expect(satisfiesRange('1.3.0', '^1.2.3')).toBe(true)
    expect(satisfiesRange('1.2.2', '^1.2.3')).toBe(false) // too low
    expect(satisfiesRange('2.0.0', '^1.2.3')).toBe(false) // major bumped
  })

  it('handles tilde ranges within major.minor', () => {
    expect(satisfiesRange('1.2.9', '~1.2.3')).toBe(true)
    expect(satisfiesRange('1.3.0', '~1.2.3')).toBe(false)
  })

  it('handles comparison operators', () => {
    expect(satisfiesRange('2.0.0', '>=1.0.0')).toBe(true)
    expect(satisfiesRange('1.0.0', '>1.0.0')).toBe(false)
    expect(satisfiesRange('0.9.0', '<1.0.0')).toBe(true)
  })

  it('is conservative on unparseable versions', () => {
    expect(satisfiesRange('1.0.0-beta', '^1.0.0')).toBe(false)
    expect(satisfiesRange('1.2.3', 'garbage')).toBe(false)
  })

  it('parses only dotted numeric versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseVersion('1.2')).toBeNull()
    expect(parseVersion('v1.2.3')).toBeNull()
  })
})