/**
 * Size statistics for the installed-plugin overview: `dirUniqueBytes` dedupes hard
 * links (same inode counted once) and skips symlink/junction entries, so the
 * figure reflects real on-disk usage, not the inflated logical sum.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirUniqueBytes } from './store-overview.ts'

let root: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-size-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('dirUniqueBytes', () => {
  it('sums distinct files, counting a hard-linked copy once', () => {
    const dir = join(root, 'a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'x.bin'), Buffer.alloc(4096, 1))
    writeFileSync(join(dir, 'y.bin'), Buffer.alloc(2048, 2))
    // Same inode as x.bin under another name.
    linkSync(join(dir, 'x.bin'), join(dir, 'x-link.bin'))
    writeFileSync(join(dir, 'sub.txt'), 'hello') // 5 bytes, nested
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 's.bin'), Buffer.alloc(1000, 3))
    expect(dirUniqueBytes(dir)).toBe(4096 + 2048 + 5 + 1000)
  })

  it('skips symlink/junction entries (their real file lives elsewhere)', () => {
    const outer = join(root, 'outer')
    const inner = join(root, 'inner')
    mkdirSync(outer, { recursive: true })
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(outer, 'o.bin'), Buffer.alloc(512, 9))
    writeFileSync(join(inner, 'i.bin'), Buffer.alloc(2048, 7))
    try {
      // dir symlink inside outer → its target (inner) is NOT part of outer's size.
      symlinkSync(inner, join(outer, 'ln'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch { /* junction may need perms — then we already covered the core path */ }
    expect(dirUniqueBytes(outer)).toBe(512)
  })

  it('handles a missing dir as zero', () => {
    expect(dirUniqueBytes(join(root, 'nope'))).toBe(0)
  })
})