/** Tests for the lightweight semver `satisfiesRange` used to decide store reuse. */
import { describe, it, expect } from 'vitest'
import { satisfiesRange, parseVersion, compareVersions, compareVersionsLoose, latestPackageVersion } from './version.ts'
import type { PackageVersionInfo } from '../../../shared/types.ts'

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

describe('latestPackageVersion', () => {
  const info = (versions: string[], distTags: Record<string, string> = {}): PackageVersionInfo =>
    ({ versions, distTags })

  it('takes the registry tag, not the first element of the version map', () => {
    // Measured on left-pad: the map comes back in publish order, so versions[0]
    // is the OLDEST release the package ever published, and four call sites were
    // treating it as the newest.
    const leftPad = info(['0.0.3', '0.0.4', '1.0.0', '1.3.0'], { latest: '1.3.0' })
    expect(leftPad.versions[0]).toBe('0.0.3')
    expect(latestPackageVersion(leftPad)).toBe('1.3.0')
  })

  it('falls back to the semver-highest when no latest tag says otherwise', () => {
    // The verification this fix was written against: a mirror is not obliged to
    // return the map in any order, so neither END is an answer.
    expect(latestPackageVersion(info(['0.0.3', '1.3.0', '0.0.9']))).toBe('1.3.0')
    expect(latestPackageVersion(info(['0.0.3', '0.1.0', '1.3.0']))).toBe('1.3.0')
    // A non-latest tag is not the answer either.
    expect(latestPackageVersion(info(['1.2.0', '1.3.0'], { next: '2.0.0-beta.1' }))).toBe('1.3.0')
    // No tag at all means no authority on stability, so the highest wins, prerelease included.
    expect(latestPackageVersion(info(['1.3.0', '2.0.0-beta.1']))).toBe('2.0.0-beta.1')
  })

  it('ignores a latest tag the version map does not carry', () => {
    // A picker whose preselected value is not among its options renders blank.
    expect(latestPackageVersion(info(['1.0.0', '1.1.0'], { latest: '9.9.9' }))).toBe('1.1.0')
    // With no versions at all the tag is the only answer there is.
    expect(latestPackageVersion(info([], { latest: '9.9.9' }))).toBe('9.9.9')
  })
  it('is undefined for a package with nothing to pick', () => {
    expect(latestPackageVersion(info([]))).toBeUndefined()
    expect(latestPackageVersion(info([], { latest: '' }))).toBeUndefined()
  })
})