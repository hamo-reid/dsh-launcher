/** IPC argument-validation primitives. Pure functions — the security boundary for
 * every path- and version-building handler. */
import { describe, expect, it } from 'vitest'
import { join, resolve, sep } from 'node:path'
import { pathIdentifierInvalid, pathOutsideRoot, rowIdInvalid, versionInvalid } from './validate.ts'

describe('pathIdentifierInvalid', () => {
  it('accepts plain names, scoped names and trash-style suffixes', () => {
    expect(pathIdentifierInvalid('my-profile')).toBe(false)
    expect(pathIdentifierInvalid('@scope/name')).toBe(false)
    expect(pathIdentifierInvalid('name (2)')).toBe(false)
    expect(pathIdentifierInvalid('a_b.c-d')).toBe(false)
  })

  it('refuses empty, traversal, separators, absolute, drive and ADS paths', () => {
    expect(pathIdentifierInvalid('')).toBe(true)
    expect(pathIdentifierInvalid('..')).toBe(true)
    expect(pathIdentifierInvalid('a/../b')).toBe(true)
    expect(pathIdentifierInvalid('a\\b')).toBe(true)
    expect(pathIdentifierInvalid('/abs')).toBe(true)
    expect(pathIdentifierInvalid('abs/')).toBe(true)
    expect(pathIdentifierInvalid('a//b')).toBe(true)
    expect(pathIdentifierInvalid('C:\\x')).toBe(true)
    // A colon anywhere is refused (drive prefix / NTFS alternate data stream).
    expect(pathIdentifierInvalid('a:b')).toBe(true)
  })

  it('refuses shell metacharacters', () => {
    for (const v of ['a`b', 'a$b', 'a;b', 'a|b', 'a&b', 'a<b', 'a>b']) {
      expect(pathIdentifierInvalid(v)).toBe(true)
    }
  })
})

describe('versionInvalid', () => {
  it('accepts real semver-ish versions (prerelease + build metadata)', () => {
    expect(versionInvalid('1.2.3')).toBe(false)
    expect(versionInvalid('2.1.0-beta.1')).toBe(false)
    expect(versionInvalid('1.0.0+build.7')).toBe(false)
  })

  it('refuses empty / separators / whitespace / other junk', () => {
    expect(versionInvalid('')).toBe(true)
    expect(versionInvalid('1/2')).toBe(true)
    expect(versionInvalid('1\\2')).toBe(true)
    expect(versionInvalid('1 2')).toBe(true)
    expect(versionInvalid('v^1')).toBe(true)
  })

  it('refuses dot-only versions that would step out of the version dir', () => {
    // `.` resolves to the plugin root; `..` to `archive/` (all plugins). Any
    // embedded `..` is refused too, even though it is harmless without a slash.
    expect(versionInvalid('.')).toBe(true)
    expect(versionInvalid('..')).toBe(true)
    expect(versionInvalid('...')).toBe(true)
    expect(versionInvalid('a..b')).toBe(true)
  })
})

describe('pathOutsideRoot', () => {
  const root = resolve('/tmp/import-tmp')

  it('counts the root itself and descendants as inside', () => {
    expect(pathOutsideRoot(root, root)).toBe(false)
    expect(pathOutsideRoot(root, join(root, 'abc'))).toBe(false)
    expect(pathOutsideRoot(root, join(root, 'a', 'b'))).toBe(false)
  })

  it('counts traversal and prefix-siblings as outside', () => {
    expect(pathOutsideRoot(root, join(root, '..'))).toBe(true)
    expect(pathOutsideRoot(root, join(root, '..', 'other'))).toBe(true)
    // A sibling whose name merely starts with the root string must still be out.
    expect(pathOutsideRoot(root, root + '-evil')).toBe(true)
    expect(pathOutsideRoot(root, resolve('/tmp/elsewhere'))).toBe(true)
  })

  it('normalizes before comparing', () => {
    expect(pathOutsideRoot(root, join(root, 'a', '..', 'b'))).toBe(false)
    expect(pathOutsideRoot(root, `${root}${sep}a`)).toBe(false)
  })
})

describe('rowIdInvalid', () => {
  it('accepts slugs and scoped names', () => {
    expect(rowIdInvalid('my-plugin')).toBe(false)
    expect(rowIdInvalid('@scope/name')).toBe(false)
    expect(rowIdInvalid('a.b_c/d')).toBe(false)
  })

  it('refuses line-breaking / YAML-significant characters', () => {
    expect(rowIdInvalid('a b')).toBe(true)
    expect(rowIdInvalid('a:b')).toBe(true)
    expect(rowIdInvalid("a'b")).toBe(true)
    expect(rowIdInvalid('a\nb')).toBe(true)
    expect(rowIdInvalid('a$b')).toBe(true)
  })
})
