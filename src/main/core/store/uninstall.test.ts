/**
 * Retiring an archived version: the store must stop listing it BEFORE its bytes
 * are touched, so a file that cannot be deleted leaves a reclaimable leftover
 * instead of a half-deleted archive the overview still reports as installed.
 *
 * `deleteTreePhysical` is also covered here: it now COLLECTS the paths it could
 * not remove instead of throwing, which is what lets a partial failure stay a
 * partial failure.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteTreePhysical, removePlugin, retireTree, sweepStoreTrash } from './uninstall.ts'
import { storeVersions } from './layout.ts'

let root: string
const store = (): string => join(root, 'store')
const trash = (): string => join(store(), '.trash')
const PKG = '@me/plugin'
const VERSION = '1.0.0'

/** An archived version with a real package body, as `storeVersions` requires. */
function seedVersion(version = VERSION): string {
  const dir = join(store(), 'archive', PKG, version, 'node_modules', PKG)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: PKG, version }))
  writeFileSync(join(dir, 'index.js'), 'export {}\n')
  return join(store(), 'archive', PKG, version)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pm-uninstall-'))
  mkdirSync(store(), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('retireTree', () => {
  it('moves the tree out of the store before deleting it', () => {
    const target = seedVersion()
    const res = retireTree(store(), target, 'leaf-1')
    expect(res).toEqual({ moved: true, failures: [] })
    expect(existsSync(target)).toBe(false)
    // Nothing is left behind when the delete succeeded.
    expect(readdirSync(trash())).toEqual([])
  })

  it('leaves the archive untouched when the move itself is refused', () => {
    const target = seedVersion()
    // A FILE where the stash directory belongs makes preparing the stash fail.
    writeFileSync(trash(), 'not a directory')
    const res = retireTree(store(), target, 'leaf-2')
    expect(res.moved).toBe(false)
    expect(res.failures).toEqual([target])
    // The version is still installed and intact — a refusal, not a half-delete.
    expect(storeVersions(store(), PKG)).toEqual([VERSION])
    expect(existsSync(join(target, 'node_modules', PKG, 'index.js'))).toBe(true)
  })
})

describe('removePlugin', () => {
  it('drops the version from the enumeration and reclaims the stash', () => {
    seedVersion()
    const res = removePlugin(store(), PKG, VERSION)
    expect(res).toMatchObject({ ok: true })
    expect(storeVersions(store(), PKG)).toEqual([])
    // The stash is emptied; the directory itself stays, like the install path's.
    expect(readdirSync(trash())).toEqual([])
  })

  it('reports a locked store as locked, not as a generic failure', () => {
    seedVersion()
    writeFileSync(trash(), 'not a directory')
    const res = removePlugin(store(), PKG, VERSION)
    expect(res.ok).toBe(false)
    expect(res.locked).toBe(true)
    expect(storeVersions(store(), PKG)).toEqual([VERSION])
  })
})

describe('sweepStoreTrash', () => {
  it('reclaims a stashed leftover and leaves the archive alone', () => {
    seedVersion()
    const leftover = join(trash(), 'stale-leftover')
    mkdirSync(leftover, { recursive: true })
    writeFileSync(join(leftover, 'x.bin'), 'x')
    sweepStoreTrash(store())
    expect(existsSync(leftover)).toBe(false)
    expect(existsSync(trash())).toBe(false)
    expect(storeVersions(store(), PKG)).toEqual([VERSION])
  })

  it('is a no-op for an unconfigured store', () => {
    expect(() => { sweepStoreTrash('') }).not.toThrow()
  })
})

describe('deleteTreePhysical', () => {
  it('unlinks a junction without following it, and reports nothing', () => {
    const target = join(root, 'outside')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'keep.txt'), 'keep')
    const tree = join(root, 'tree')
    mkdirSync(tree, { recursive: true })
    symlinkSync(target, join(tree, 'link'), 'junction')
    expect(deleteTreePhysical(tree)).toEqual([])
    expect(existsSync(tree)).toBe(false)
    // The junction pointed outside; its target must survive.
    expect(existsSync(join(target, 'keep.txt'))).toBe(true)
  })

  it('reports nothing for a tree that is already gone', () => {
    // `force: true` on a missing path is not a failure — a delete is idempotent,
    // and callers use the return value to mean "something is still holding this".
    expect(deleteTreePhysical(join(root, 'does-not-exist'))).toEqual([])
  })

  it('empties a real tree and reports nothing', () => {
    const tree = join(root, 'full')
    mkdirSync(join(tree, 'sub'), { recursive: true })
    writeFileSync(join(tree, 'a.txt'), 'a')
    writeFileSync(join(tree, 'sub', 'b.txt'), 'b')
    expect(deleteTreePhysical(tree)).toEqual([])
    expect(existsSync(tree)).toBe(false)
  })
})
