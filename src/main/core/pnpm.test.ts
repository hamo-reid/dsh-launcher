/**
 * pnpm wiring tests. `installSucceeded` is pure string logic; `runPnpm` is driven
 * entirely by a mocked spawn so every terminal branch (clean / ignored-builds /
 * genuine failure / spawn error / in-flight abort) is covered without spawning a
 * real child or needing a network install.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePnpmStore, installSucceeded, pnpmStoreDir, runPnpm } from './pnpm.ts'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

/** A controllable ChildProcess look-alike: EventEmitter for `on`/`emit`, plus the
 * pid/stdout/stderr runPnpm reads. */
function fakeChild(pid = 321): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number } {
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  })
  return child
}

describe('installSucceeded', () => {
  it('is true when output shows added packages', () => {
    expect(installSucceeded('Progress: resolved 582, reused 525, downloaded 0, added 523, done\n+ @deepseek-ai/dsh 0.1.0-rc.7')).toBe(true)
    expect(installSucceeded('added 23 packages')).toBe(true)
  })

  it('is true on the Done-in marker', () => {
    expect(installSucceeded('Done in 10.1s using pnpm v10.33.0')).toBe(true)
  })

  it('is false for a pure error / empty output', () => {
    expect(installSucceeded('ERR_PNPM_OUTDATED_LOCKFILE: Cannot install with frozen-lockfile')).toBe(false)
    expect(installSucceeded('')).toBe(false)
  })

  it('is false when resolution failed with added 0 (progress line, not install)', () => {
    // A dependency-resolve failure can exit non-zero yet leave `added 0` in the
    // progress lines — that must not be mistaken for a successful install.
    expect(installSucceeded('Progress: resolved 98, reused 98, downloaded 0, added 0')).toBe(false)
    expect(installSucceeded('added 0 packages in 1s')).toBe(false)
  })
})

describe('runPnpm (spawn mocked)', () => {
  beforeEach(() => spawnMock.mockReset())

  it('resolves ok on a clean exit-0 run', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const p = runPnpm('/dir', ['install'])
    child.stdout.emit('data', Buffer.from('Progress: resolved 5, added 5 done'))
    child.emit('close', 0)
    await expect(p).resolves.toMatchObject({ ok: true })
  })

  it('counts a non-zero exit as ok when output shows packages added', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const p = runPnpm('/dir', ['install'])
    child.stdout.emit('data', Buffer.from('ERR_PNPM_IGNORED_BUILDS\nadded 3 packages'))
    child.emit('close', 1)
    await expect(p).resolves.toMatchObject({ ok: true })
  })

  it('reports failure on a non-zero exit with no install markers', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const p = runPnpm('/dir', ['install'])
    child.stderr.emit('data', Buffer.from('ERR_PNPM_OUTDATED_LOCKFILE: Cannot install'))
    child.emit('close', 1)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.text).toContain('ERR_PNPM_OUTDATED_LOCKFILE')
  })

  it('resolves a spawn error event as a failure with its message', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const p = runPnpm('/dir', ['install'])
    child.emit('error', new Error('spawn ENOENT'))
    await expect(p).resolves.toMatchObject({ ok: false, text: 'spawn ENOENT' })
  })

  it('honours an already-aborted signal and reports aborted', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const ac = new AbortController()
    ac.abort()
    const p = runPnpm('/dir', ['install'], ac.signal)
    child.emit('close', 1)
    await expect(p).resolves.toMatchObject({ ok: false, aborted: true })
  })

  it('aborts a run in flight when the signal fires', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const ac = new AbortController()
    const p = runPnpm('/dir', ['install'], ac.signal)
    ac.abort() // triggers onAbort → killProcessTree (taskkill spawn, ignored)
    child.emit('close', 1)
    await expect(p).resolves.toMatchObject({ ok: false, aborted: true })
  })
})

describe('ensurePnpmStore (library-scoped store seeding)', () => {
  beforeEach(() => { delete process.env.APPDATA })

  it('hard-links the same-volume default store content into .pnpm-store', () => {
    // A fake "default pnpm store" under APPDATA, same volume as storeDir (both tmp).
    const appData = mkdtempSync(join(tmpdir(), 'pm-appdata-'))
    process.env.APPDATA = appData
    const v10 = join(appData, 'pnpm', 'store', 'v10')
    mkdirSync(v10, { recursive: true })
    writeFileSync(join(v10, 'packages.json'), '{"a":1}')

    const storeDir = mkdtempSync(join(tmpdir(), 'pm-lib-'))
    ensurePnpmStore(storeDir)

    const seeded = join(pnpmStoreDir(storeDir), 'v10', 'packages.json')
    expect(existsSync(seeded)).toBe(true)
    // Same on-disk file (hard-linked), not a copy.
    expect(statSync(seeded).ino).toBe(statSync(join(v10, 'packages.json')).ino)
  })

  it('is a no-op once the library store already exists', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'pm-lib2-'))
    mkdirSync(pnpmStoreDir(storeDir), { recursive: true })
    writeFileSync(join(pnpmStoreDir(storeDir), 'probe'), 'x')
    // Nonexistent default store: without the existing guard this would try to seed.
    ensurePnpmStore(storeDir)
    expect(existsSync(join(pnpmStoreDir(storeDir), 'probe'))).toBe(true)
  })
})