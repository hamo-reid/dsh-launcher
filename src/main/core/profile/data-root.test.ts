/**
 * Relocating the launcher data root: the dry run, copy verification, the dsh
 * registry rewrite, and a real move over a temp tree (including the pnpm-cache
 * exclusion and the idempotent re-run after a partial failure).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  dshInstancesOf, moveDataRoot, planDataRootMove, planDshRemap, remapDshEntries, verifyCopy,
} from './data-root.ts'
import type { DshEntry } from '../../../shared/types.ts'

let root: string

const sources = (): { plugins: string; skillLibrary: string; dshVersions: string } => ({
  plugins: join(root, 'src', 'plugins'),
  skillLibrary: join(root, 'src', 'skill-library'),
  dshVersions: join(root, 'src', 'dsh', 'versions'),
})
const target = (): string => join(root, 'dst')

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** Lay down a fake dsh install. The manifest under
 * `node_modules/@deepseek-ai/dsh` IS the discovery criterion
 * `discoverVersionRepo` uses, so this is what makes an instance real. */
function makeDsh(repo: string, name: string): void {
  const dir = join(repo, name)
  write(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' }))
  write(join(dir, 'node_modules', '.bin', 'dsh.cmd'), '')
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-dataroot-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('planDataRootMove', () => {
  it('derives every destination under the target, all absent on an empty source', () => {
    const plan = planDataRootMove(sources(), target())
    expect(plan.items.map(i => [i.key, i.to])).toEqual([
      ['plugins', join(target(), 'plugins')],
      ['skillLibrary', join(target(), 'skill-library')],
      ['dshVersions', join(target(), 'dsh', 'versions')],
    ])
    expect(plan.items.every(i => i.absent)).toBe(true)
  })

  it('counts a version repo by its installs, not by its top-level clutter', () => {
    const repo = join(root, 'count', 'versions')
    write(join(repo, 'stray-file.txt'), 'not an install')
    mkdirSync(join(repo, 'not-an-install'), { recursive: true })
    makeDsh(repo, 'a')
    makeDsh(repo, 'b')

    const plan = planDataRootMove({ ...sources(), dshVersions: repo }, target())
    const item = plan.items.find(i => i.key === 'dshVersions')
    expect(item?.absent).toBe(false)
    expect(item?.entries).toBe(2)
  })

  it('flags an occupied destination', () => {
    const dst = join(root, 'occupied')
    write(join(dst, 'plugins', 'leftover.txt'), 'x')
    const plan = planDataRootMove(sources(), dst)
    expect(plan.items.find(i => i.key === 'plugins')?.occupied).toBe(true)
    expect(plan.items.find(i => i.key === 'skillLibrary')?.occupied).toBe(false)
  })
})

describe('verifyCopy', () => {
  const src = (): string => join(root, 'verify', 'src')
  const dst = (): string => join(root, 'verify', 'dst')

  it('accepts an identical tree', () => {
    write(join(src(), 'a.txt'), 'hello')
    write(join(src(), 'nested', 'b.txt'), 'world')
    write(join(dst(), 'a.txt'), 'hello')
    write(join(dst(), 'nested', 'b.txt'), 'world')
    expect(verifyCopy(src(), dst())).toEqual({ ok: true, missing: [], mismatched: [] })
  })

  it('reports a file the copy did not produce', () => {
    rmSync(join(dst(), 'a.txt'), { force: true })
    const result = verifyCopy(src(), dst())
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['a.txt'])
  })

  it('reports a size mismatch (a truncated copy)', () => {
    write(join(dst(), 'a.txt'), 'hel')
    const result = verifyCopy(src(), dst())
    expect(result.ok).toBe(false)
    expect(result.mismatched).toEqual(['a.txt'])
  })

  it('ignores the pnpm cache on both sides', () => {
    // A directory pair of its own: the shared one above has been deliberately
    // corrupted by the mismatch case.
    const cacheSrc = join(root, 'verify-cache', 'src')
    const cacheDst = join(root, 'verify-cache', 'dst')
    write(join(cacheSrc, 'a.txt'), 'hello')
    write(join(cacheSrc, '.pnpm-store', 'chunk.bin'), 'cache')
    write(join(cacheDst, 'a.txt'), 'hello')
    expect(verifyCopy(cacheSrc, cacheDst).ok).toBe(true)
  })
})

describe('planDshRemap / remapDshEntries', () => {
  it('pairs installs by name and rewrites id, execPath, home and versionDir', () => {
    const oldRepo = join(root, 'remap', 'old', 'versions')
    const newRepo = join(root, 'remap', 'new', 'versions')
    makeDsh(oldRepo, 'inst')
    makeDsh(newRepo, 'inst')

    const remap = planDshRemap(oldRepo, newRepo)
    expect(remap).toHaveLength(1)

    const before: DshEntry = {
      id: remap[0].oldExecPath, name: 'inst', execPath: remap[0].oldExecPath,
      version: '1.2.3', home: remap[0].oldHome,
    }
    const [after] = remapDshEntries([before], remap)
    expect(after.id).toBe(remap[0].newExecPath)
    expect(after.execPath).toBe(remap[0].newExecPath)
    expect(after.home).toBe(join(root, 'remap', 'new', 'homes', 'inst'))
    expect(after.versionDir).toBe(newRepo)
    expect(after.name).toBe('inst')
  })

  it('leaves an install that did not move untouched', () => {
    const entry: DshEntry = { id: '/x', name: 'other', execPath: '/x', version: '1', home: '/h' }
    expect(remapDshEntries([entry], [])).toEqual([entry])
    expect(remapDshEntries([entry], [{
      oldExecPath: '/y', newExecPath: '/z', oldHome: '/h2', newHome: '/h3', newVersionDir: '/v',
    }])).toEqual([entry])
  })
})

describe('moveDataRoot', () => {
  it('copies the selected items, keeps the sources, and skips the pnpm cache', async () => {
    const base = join(root, 'e2e')
    const src = join(base, 'src')
    write(join(src, 'plugins', 'archive', 'pkg', '1.0.0', 'package.json'), '{}')
    write(join(src, 'plugins', '.pnpm-store', 'chunk.bin'), 'cache')
    write(join(src, 'skill-library', 'greeter', 'SKILL.md'), '# greeter')

    const plan = planDataRootMove({
      plugins: join(src, 'plugins'),
      skillLibrary: join(src, 'skill-library'),
      dshVersions: join(src, 'dsh', 'versions'),
    }, join(base, 'dst'))

    const outcome = await moveDataRoot(plan, ['plugins', 'skillLibrary'])
    expect(outcome.failed).toEqual([])
    expect(outcome.results.map(r => [r.key, r.status])).toEqual([['plugins', 'moved'], ['skillLibrary', 'moved']])

    expect(readFileSync(join(base, 'dst', 'plugins', 'archive', 'pkg', '1.0.0', 'package.json'), 'utf8')).toBe('{}')
    expect(existsSync(join(base, 'dst', 'skill-library', 'greeter', 'SKILL.md'))).toBe(true)
    // The cache is deliberately left behind; the source is deliberately kept.
    expect(existsSync(join(base, 'dst', 'plugins', '.pnpm-store'))).toBe(false)
    expect(existsSync(join(src, 'plugins', 'archive', 'pkg', '1.0.0', 'package.json'))).toBe(true)
  })

  it('is idempotent: a re-run over an identical destination copies nothing', async () => {
    const base = join(root, 'e2e')
    const plan = planDataRootMove({
      plugins: join(base, 'src', 'plugins'),
      skillLibrary: join(base, 'src', 'skill-library'),
      dshVersions: join(base, 'src', 'dsh', 'versions'),
    }, join(base, 'dst'))

    const outcome = await moveDataRoot(plan, ['plugins', 'skillLibrary'])
    expect(outcome.results.map(r => r.status)).toEqual(['already-there', 'already-there'])
    expect(outcome.results.every(r => r.archived === undefined)).toBe(true)
  })

  it('renames an occupied destination aside instead of merging into it', async () => {
    const base = join(root, 'occupied-move')
    const src = join(base, 'src')
    write(join(src, 'plugins', 'fresh.txt'), 'new')
    write(join(base, 'dst', 'plugins', 'stale.txt'), 'old')

    const plan = planDataRootMove({
      plugins: join(src, 'plugins'),
      skillLibrary: join(src, 'skill-library'),
      dshVersions: join(src, 'dsh', 'versions'),
    }, join(base, 'dst'))

    const outcome = await moveDataRoot(plan, ['plugins'])
    const moved = outcome.results[0]
    expect(moved.status).toBe('moved')
    expect(moved.archived).toBeDefined()
    // The new tree holds only the source's contents; the old one survives intact.
    expect(existsSync(join(base, 'dst', 'plugins', 'fresh.txt'))).toBe(true)
    expect(existsSync(join(base, 'dst', 'plugins', 'stale.txt'))).toBe(false)
    expect(existsSync(join(moved.archived ?? '', 'stale.txt'))).toBe(true)
  })

  it('moves a version repo together with the homes beside it', async () => {
    const base = join(root, 'dsh-move')
    const srcRepo = join(base, 'src', 'dsh', 'versions')
    makeDsh(srcRepo, 'inst')
    write(join(base, 'src', 'dsh', 'homes', 'inst', 'profiles', 'p', 'package.json'), '{}')

    const plan = planDataRootMove({
      plugins: join(base, 'src', 'plugins'),
      skillLibrary: join(base, 'src', 'skill-library'),
      dshVersions: srcRepo,
    }, join(base, 'dst'))

    const outcome = await moveDataRoot(plan, ['dshVersions'])
    expect(outcome.failed).toEqual([])
    const dstRepo = join(base, 'dst', 'dsh', 'versions')
    expect(existsSync(join(dstRepo, 'inst', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))).toBe(true)
    // A home left behind would orphan every profile under it.
    expect(existsSync(join(base, 'dst', 'dsh', 'homes', 'inst', 'profiles', 'p', 'package.json'))).toBe(true)
    expect(outcome.remap).toHaveLength(1)
    expect(outcome.remap[0].newHome).toBe(join(base, 'dst', 'dsh', 'homes', 'inst'))
    expect(dshInstancesOf(dstRepo)).toHaveLength(1)
  })
})
