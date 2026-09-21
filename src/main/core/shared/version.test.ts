/** Tests for the lightweight semver `satisfiesRange` used to decide store reuse. */
import { describe, it, expect } from 'vitest'
import { satisfiesRange, parseVersion, compareVersions, compareVersionsLoose } from './version.ts'

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

  it('parses dotted numeric versions (three-part; a v prefix and prerelease accepted)', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseVersion('1.2')).toBeNull()
    expect(parseVersion('1.2.3-beta')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
  })
})

describe('compareVersions', () => {
  it('orders ascending', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1)
    expect(compareVersions('1.9.0', '2.0.0')).toBe(-1)
    expect(compareVersions('2.0.0', '1.9.0')).toBe(1)
  })

  it('treats truly unparseable versions as less than parseable ones (prerelease parses)', () => {
    expect(compareVersions('1.2.3-beta', '1.2.4')).toBe(-1) // prerelease < its release
    expect(compareVersions('1.2.4', '1.3.0-dev')).toBe(-1) // prerelease is a real higher version
    expect(compareVersions('', '')).toBe(0)
    expect(compareVersions('not-a-version', 'also-bad')).toBe(0)
  })
})

describe('compareVersionsLoose', () => {
  it('handles prerelease versions against the right release tuple', () => {
    expect(compareVersionsLoose('2.0.0-beta.1', '1.9.0')).toBe(1) // higher major, above stable
    expect(compareVersionsLoose('2.0.0-beta.1', '2.0.0')).toBe(-1) // pre < its release
    expect(compareVersionsLoose('1.0.2', '1.0.1')).toBe(1)
  })

  it('falls back to 0 for unparseable input', () => {
    expect(compareVersionsLoose('dev', '1.0.0')).toBe(0)
  })
})