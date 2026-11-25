/**
 * Tests for dsh home disk usage: the read-only walk, the hard-link arithmetic the
 * whole feature rests on, the `profiles` node_modules attribution, and the
 * managed-only grouping.
 *
 * Pure — builds temp trees only (never a real dsh home, never `~/.dsh`), no
 * Electron and no pnpm. Hard links are the point here, so the tests create them
 * for real: on NTFS `linkSync` needs no elevation, and the numbers below only
 * mean anything if `stat` reports the multi-link count we expect.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { browseDir, gatherHomeUsage, homeTargets, measureHome, resolveInHome, roleOf, scanHome } from './home-usage.ts'
import type { DshEntry } from '../../../shared/types.ts'

let root = ''

/** Create (and return) a directory under the temp root. */
function dir(...segments: string[]): string {
  const p = join(root, ...segments)
  mkdirSync(p, { recursive: true })
  return p
}

/** Create an already-absolute directory (one we did not derive from `root`). */
function mkdirp(path: string): void {
  mkdirSync(path, { recursive: true })
}

/** Write a file of `size` bytes and return its path. */
function file(path: string, size: number): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x'.repeat(size))
  return path
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-home-usage-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const entry = (id: string, home: string, managed: boolean): DshEntry =>
  ({ id, name: id, execPath: join(root, 'dsh', id, 'dsh.cmd'), version: '1', home, ...(managed ? { managed: true } : {}) })

const byName = (usage: ReturnType<typeof measureHome>, name: string) => {
  const found = usage.entries.find(e => e.name === name)
  if (found === undefined) throw new Error(`entry "${name}" missing from ${usage.entries.map(e => e.name).join(', ')}`)
  return found
}

describe('roleOf', () => {
  it('labels the names it knows and never drops the rest', () => {
    expect(roleOf('profiles')).toBe('profiles')
    expect(roleOf('sessions')).toBe('sessions')
    expect(roleOf('plugin-data')).toBe('plugin-data')
    expect(roleOf('.agent-presets')).toBe('agent-presets')
    expect(roleOf('settings.yaml')).toBe('config')
    // A layout newer than this build must still be measured and shown.
    expect(roleOf('something-new')).toBe('unknown')
  })
})

describe('measureHome', () => {
  it('reports an absent home instead of throwing (the host creates it lazily)', () => {
    const usage = measureHome(join(root, 'never-created'))
    expect(usage.exists).toBe(false)
    expect(usage.entries).toEqual([])
    expect(usage.apparentBytes).toBe(0)
    expect(usage.reclaimableBytes).toBe(0)
  })

  it('splits a home into top-level rows, largest first', () => {
    const home = dir('m-basic')
    file(join(home, 'sessions', 'w1', 'session.jsonl.zstd'), 900)
    file(join(home, 'attachments', 'v1', 'img.bin'), 300)
    file(join(home, 'settings.yaml'), 40)
    mkdirp(join(home, 'an-unknown-dir'))

    const usage = measureHome(home)
    expect(usage.exists).toBe(true)
    expect(usage.entries.map(e => e.name)).toEqual(['sessions', 'attachments', 'settings.yaml', 'an-unknown-dir'])
    expect(byName(usage, 'sessions').apparentBytes).toBe(900)
    expect(byName(usage, 'attachments').apparentBytes).toBe(300)
    expect(byName(usage, 'settings.yaml').kind).toBe('file')
    expect(byName(usage, 'settings.yaml').role).toBe('config')
    expect(byName(usage, 'an-unknown-dir').role).toBe('unknown')
    expect(usage.files).toBe(3)
    expect(usage.apparentBytes).toBe(1240)
    // Nothing here is hard-linked: everything is reclaimable.
    expect(usage.reclaimableBytes).toBe(1240)
    expect(usage.sharedBytes).toBe(0)
  })

  it('counts a file hard-linked inside one home once as reclaimable, twice as apparent', () => {
    const home = dir('m-inside')
    const first = file(join(home, 'profiles', 'p1', 'cordis.yml'), 100)
    linkSync(first, join(home, 'profiles', 'p1', 'cordis.copy.yml'))

    const usage = measureHome(home)
    const profiles = byName(usage, 'profiles')
    // Two directory entries report 100 bytes each, so a file explorer shows 200…
    expect(profiles.apparentBytes).toBe(200)
    // …but both links live in this home, so deleting it frees 100 of those bytes.
    expect(profiles.reclaimableBytes).toBe(100)
    expect(profiles.sharedBytes).toBe(0)
    expect(profiles.files).toBe(2)
  })

  it('counts bytes linked across two top-level entries as reclaimable for the HOME', () => {
    // Two folders of the SAME home sharing one body: deleting either folder alone
    // frees nothing (the other still holds a link), but deleting the home does.
    // Adding up the per-folder numbers would report 0 and lose those bytes.
    const home = dir('m-cross')
    const body = file(join(home, 'sessions', 'a.jsonl'), 300)
    mkdirp(join(home, 'attachments'))
    linkSync(body, join(home, 'attachments', 'b.bin'))

    const usage = measureHome(home)
    expect(byName(usage, 'sessions').reclaimableBytes).toBe(0)
    expect(byName(usage, 'sessions').sharedBytes).toBe(300)
    expect(byName(usage, 'attachments').reclaimableBytes).toBe(0)
    // The home owns every link, so the home total is not the sum of its parts.
    expect(usage.reclaimableBytes).toBe(300)
    expect(usage.sharedBytes).toBe(0)
    // Apparent stays a raw sum: two directory entries, two reported sizes.
    expect(usage.apparentBytes).toBe(600)
  })

  it('treats bytes with a link outside the home as shared, not reclaimable', () => {
    // The plugin store / dsh install case: the body lives elsewhere and the home
    // only holds one more link to it.
    const body = file(join(root, 'outside-store', 'body.js'), 500)
    const home = dir('m-outside')
    linkSync(body, join(home, 'linked.js'))

    const usage = measureHome(home)
    const linked = byName(usage, 'linked.js')
    expect(linked.apparentBytes).toBe(500)
    expect(linked.reclaimableBytes).toBe(0)
    expect(linked.sharedBytes).toBe(500)
    expect(usage.reclaimableBytes).toBe(0)
  })

  it('attributes a profile node_modules separately and says where the bytes live', () => {
    const home = dir('m-nm')
    file(join(home, 'profiles', 'p1', 'package.json'), 10)
    file(join(home, 'profiles', 'p1', 'node_modules', 'pkg', 'index.js'), 300)
    file(join(home, 'profiles', 'p2', 'node_modules', 'pkg', 'index.js'), 70)
    file(join(home, 'sessions', 's.jsonl'), 20)

    const usage = measureHome(home)
    const profiles = byName(usage, 'profiles')
    expect(profiles.apparentBytes).toBe(380)
    expect(profiles.nodeModulesBytes).toBe(370)
    // Only `profiles` carries the note; every other row stays plain.
    expect(byName(usage, 'sessions').nodeModulesBytes).toBeUndefined()
    // The node_modules bytes are still part of the home's own apparent total —
    // they are annotated, not hidden.
    expect(usage.apparentBytes).toBe(400)
  })

  it('does not follow a symlink out of the home', () => {
    const target = file(join(root, 'link-target', 'big.bin'), 4096)
    const home = dir('m-link')
    file(join(home, 'small.txt'), 5)
    try {
      symlinkSync(target, join(home, 'pointer.bin'))
    } catch {
      // Symlink creation needs a privilege (or Developer Mode) on Windows. The
      // assertion below is about NOT following one, so skip when we cannot make one.
      return
    }
    const usage = measureHome(home)
    // The target is counted where it lives; the home only holds a pointer.
    expect(usage.apparentBytes).toBe(5)
    expect(usage.entries.map(e => e.name)).toEqual(['small.txt'])
  })

  it('marks a scan that hit its entry budget as truncated', () => {
    const home = dir('m-budget')
    for (let i = 0; i < 5; i += 1) file(join(home, 'sessions', `f${String(i)}.log`), 10)
    const usage = measureHome(home, { maxEntries: 2 })
    expect(usage.truncated).toBe(true)
    // A partial walk must not claim to have seen everything.
    expect(usage.files).toBeLessThan(5)
  })

  it('stays within the entry budget rather than reading on', () => {
    const home = dir('m-budget2')
    for (let i = 0; i < 4; i += 1) file(join(home, 'logs', `f${String(i)}.log`), 1)
    const usage = measureHome(home, { maxEntries: 100 })
    expect(usage.truncated).toBe(false)
    expect(usage.files).toBe(4)
  })
})

describe('gatherHomeUsage', () => {
  it('ignores installs the launcher does not manage', () => {
    const home = dir('g-unmanaged')
    file(join(home, 'sessions', 's.jsonl'), 100)
    const versionRoot = dir('g-vr1')
    // Not `managed`, and its executable is not inside the version repo.
    const rows = gatherHomeUsage([entry('sys', home, false)], versionRoot)
    expect(rows).toEqual([])
  })

  it('measures a home shared by several dsh once, naming every owner', () => {
    const home = dir('g-shared')
    file(join(home, 'sessions', 's.jsonl'), 100)
    const versionRoot = dir('g-vr2')
    const rows = gatherHomeUsage([entry('a', home, true), entry('b', home, true)], versionRoot)
    expect(rows).toHaveLength(1)
    expect(rows[0].dshIds).toEqual(['a', 'b'])
    expect(rows[0].apparentBytes).toBe(100)
  })

  it('does not measure one home twice when it is spelled two ways', () => {
    // `dsh:setHome` accepts free text, so the same directory can arrive with a
    // trailing separator (and, on Windows, different casing).
    const home = dir('g-spelled')
    file(join(home, 'sessions', 's.jsonl'), 100)
    const versionRoot = dir('g-vr2b')
    const spelled = `${home}${process.platform === 'win32' ? '\\' : '/'}`
    const rows = gatherHomeUsage([entry('a', home, true), entry('b', spelled, true)], versionRoot)
    expect(rows).toHaveLength(1)
    expect(rows[0].dshIds).toEqual(['a', 'b'])
    expect(rows[0].apparentBytes).toBe(100)
  })

  it('orders homes by what deleting them would actually free', () => {
    const small = dir('g-small')
    file(join(small, 'sessions', 's.jsonl'), 10)
    const big = dir('g-big')
    file(join(big, 'sessions', 's.jsonl'), 5000)
    const versionRoot = dir('g-vr3')
    const rows = gatherHomeUsage([entry('s', small, true), entry('b', big, true)], versionRoot)
    expect(rows.map(r => r.home)).toEqual([big, small])
  })

  it('recognises a managed install by its version repo even without the marker', () => {
    // The `managed` flag can be clobbered by a re-registration; the structural
    // signal (executable under the repo) still says it is ours.
    const home = dir('g-detected')
    file(join(home, 'settings.yaml'), 7)
    const versionRoot = dir('g-repo')
    const execPath = file(join(versionRoot, 'official', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 3)
    const rows = gatherHomeUsage([{ id: 'legacy', name: 'legacy', execPath, version: '1', home }], versionRoot)
    expect(rows).toHaveLength(1)
    expect(rows[0].reclaimableBytes).toBe(7)
  })
})

describe('homeTargets / scanHome', () => {
  it('lists the managed homes without measuring anything (the cheap first step)', () => {
    const home = dir('t-targets')
    file(join(home, 'sessions', 's.jsonl'), 10)
    const versionRoot = dir('t-vr')
    const targets = homeTargets([entry('a', home, true), entry('sys', dir('t-sys'), false)], versionRoot)
    expect(targets).toHaveLength(1)
    expect(targets[0].home).toBe(resolve(home))
    expect(targets[0].dshIds).toEqual(['a'])
  })

  it('measures one target at a time, labelling the row with its owners', () => {
    const home = dir('t-scan')
    file(join(home, 'sessions', 's.jsonl'), 10)
    const versionRoot = dir('t-vr2')
    const [target] = homeTargets([entry('a', home, true), entry('b', home, true)], versionRoot)
    const row = scanHome(target)
    expect(row.apparentBytes).toBe(10)
    expect(row.dshIds).toEqual(['a', 'b'])
    // One home per call is what lets the page paint results as they land.
    expect(homeTargets([entry('a', home, true), entry('b', home, true)], versionRoot)).toHaveLength(1)
  })
})

describe('resolveInHome', () => {
  it('resolves the root itself and a nested path', () => {
    const home = dir('r-home')
    expect(resolveInHome(home, '')).toBe(resolve(home))
    expect(resolveInHome(home, 'profiles/p1')).toBe(resolve(join(home, 'profiles', 'p1')))
    // The UI builds paths with '/', Windows takes '\' — both must land the same.
    expect(resolveInHome(home, 'profiles\\p1')).toBe(resolve(join(home, 'profiles', 'p1')))
  })

  it('refuses anything that would leave the home', () => {
    const home = dir('r-home2')
    // A sibling whose name starts with the home's own must not slip through.
    dir('r-home2-other')
    expect(resolveInHome(home, '..')).toBeUndefined()
    expect(resolveInHome(home, '../other')).toBeUndefined()
    expect(resolveInHome(home, 'a/../../b')).toBeUndefined()
    expect(resolveInHome(home, '../r-home2-other')).toBeUndefined()
    // An absolute path must not silently REPLACE the home.
    expect(resolveInHome(home, join(root, 'g-big'))).toBeUndefined()
  })
})

describe('browseDir', () => {
  it('lists one level, largest first, and totals the whole level', () => {
    const home = dir('b-level')
    file(join(home, 'sessions', 'a.jsonl'), 20)
    file(join(home, 'sessions', 'b.jsonl'), 500)
    file(join(home, 'settings.yaml'), 3)

    const rootLevel = browseDir(home, home)
    expect(rootLevel.exists).toBe(true)
    expect(rootLevel.relPath).toBe('')
    expect(rootLevel.entries.map(e => e.name)).toEqual(['sessions', 'settings.yaml'])
    expect(rootLevel.entries[0].apparentBytes).toBe(520)
    expect(rootLevel.apparentBytes).toBe(523)

    const sessions = browseDir(home, join(home, 'sessions'))
    expect(sessions.relPath).toBe('sessions')
    expect(sessions.entries.map(e => e.name)).toEqual(['b.jsonl', 'a.jsonl'])
    expect(sessions.apparentBytes).toBe(520)
  })

  it('reports a missing directory instead of throwing', () => {
    const home = dir('b-missing')
    const level = browseDir(home, join(home, 'nope'))
    expect(level.exists).toBe(false)
    expect(level.entries).toEqual([])
    expect(level.relPath).toBe('nope')
  })

  it('caps the returned rows, says how many were left out, and still totals them', () => {
    const home = dir('b-cap')
    for (let i = 0; i < 5; i += 1) file(join(home, 'sessions', `f${String(i)}.log`), 10 * (i + 1))
    const level = browseDir(home, join(home, 'sessions'), { limit: 2 })
    expect(level.entries).toHaveLength(2)
    expect(level.omitted).toBe(3)
    // 10+20+30+40+50 — the totals cover the level, not just the two rows shown.
    expect(level.apparentBytes).toBe(150)
    expect(level.entries[0].apparentBytes).toBe(50)
  })

  it('reports every unshown child as omitted, including ones it never reached', () => {
    const home = dir('b-cap2')
    for (let i = 0; i < 6; i += 1) file(join(home, 'sessions', `f${String(i)}.log`), 10)
    const level = browseDir(home, join(home, 'sessions'), { maxEntries: 2 })
    expect(level.truncated).toBe(true)
    expect(level.entries.length).toBeLessThan(6)
    // Shown + omitted must account for the whole folder: a level that stopped
    // early would otherwise look complete.
    expect(level.entries.length + level.omitted).toBe(6)
  })

  it('marks a node_modules child as bytes that came from the store', () => {
    const home = dir('b-nm')
    file(join(home, 'profiles', 'p1', 'package.json'), 5)
    file(join(home, 'profiles', 'p1', 'node_modules', 'pkg', 'index.js'), 400)
    const level = browseDir(home, join(home, 'profiles', 'p1'))
    const nodeModules = level.entries.find(e => e.name === 'node_modules')
    expect(nodeModules).toBeDefined()
    expect(nodeModules?.role).toBe('deps')
    // The whole level is hard-linked in, which is what the row's tag reads.
    expect(nodeModules?.nodeModulesBytes).toBe(400)
    // A plain sibling carries no such note.
    expect(level.entries.find(e => e.name === 'package.json')?.nodeModulesBytes).toBeUndefined()
  })
})
