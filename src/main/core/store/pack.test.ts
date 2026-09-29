/**
 * Packing a dev package for the store. `runPnpm` is mocked, so what is under
 * test is the launcher's own contract: where the tarball goes, what survives a
 * failure, and which failure is worth naming instead of dumping pnpm's output.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../dsh/pnpm.ts', async (importActual) => {
  const actual = await importActual<typeof import('../dsh/pnpm.ts')>()
  return { ...actual, runPnpm: vi.fn() }
})
import { runPnpm } from '../dsh/pnpm.ts'
import { packDevPackage, packDir } from './pack.ts'
import type { DevPlugin } from '../../../shared/types.ts'

let root: string
const store = (): string => join(root, 'store')
const devDir = (): string => join(root, 'repo', 'packages', 'foo')

/** A registered dev plugin whose manifest is already on disk. */
function makeDev(manifest: Record<string, unknown> = {}): DevPlugin {
  mkdirSync(devDir(), { recursive: true })
  writeFileSync(join(devDir(), 'package.json'), JSON.stringify({ name: '@me/dsh-foo', version: '0.1.0', ...manifest }))
  return { name: '@me/dsh-foo', dir: devDir(), bundle: false, addedAt: '2026-01-01T00:00:00.000Z' }
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-pack-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  vi.mocked(runPnpm).mockReset()
})

describe('packDevPackage', () => {
  it('packs in the dev repo with no launcher store injected, into a per-package dir', async () => {
    const dev = makeDev()
    vi.mocked(runPnpm).mockImplementation(async () => {
      // pnpm names the tarball itself; the launcher must not predict it.
      writeFileSync(join(packDir(store(), '@me/dsh-foo'), 'deepseek-ai-dsh-foo-0.1.0.tgz'), '')
      return { ok: true, text: 'packed', command: 'pnpm pack' }
    })
    const r = await packDevPackage(dev, store())
    expect(r.ok).toBe(true)
    expect(r.tgz).toBe(join(packDir(store(), '@me/dsh-foo'), 'deepseek-ai-dsh-foo-0.1.0.tgz'))
    // The user's repo keeps its own pnpm store â€?injecting the launcher's would
    // fight whatever that repo is configured to do.
    expect(runPnpm).toHaveBeenCalledWith(
      devDir(), ['pack', '--pack-destination', packDir(store(), '@me/dsh-foo')], undefined, { skipStoreDir: true },
    )
  })

  it('keeps the tarball: the archive re-resolves its file: dependency through it', async () => {
    const dev = makeDev()
    vi.mocked(runPnpm).mockImplementation(async () => {
      writeFileSync(join(packDir(store(), '@me/dsh-foo'), 'x.tgz'), '')
      return { ok: true, text: 'packed' }
    })
    await packDevPackage(dev, store())
    expect(readdirSync(packDir(store(), '@me/dsh-foo'))).toEqual(['x.tgz'])
  })

  it('replaces a stale tarball from an earlier run rather than reading it as this one', async () => {
    const dev = makeDev()
    const dest = packDir(store(), '@me/dsh-foo')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'old.tgz'), '')
    vi.mocked(runPnpm).mockImplementation(async () => ({ ok: true, text: 'packed' }))
    const r = await packDevPackage(dev, store())
    // A run that produced nothing must not report the previous run's tarball.
    expect(r.ok).toBe(false)
    expect(existsSync(dest)).toBe(false)
  })

  it('names the one failure that has a one-command fix', async () => {
    const dev = makeDev()
    vi.mocked(runPnpm).mockResolvedValue({
      ok: false,
      text: 'ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL  Cannot resolve workspace protocol of dependency "@dsh/core"',
    })
    const r = await packDevPackage(dev, store())
    expect(r.ok).toBe(false)
    expect(r.needsInstall).toBe(true)
    expect(r.text).toContain('pnpm install')
    expect(existsSync(packDir(store(), '@me/dsh-foo'))).toBe(false)
  })

  it('passes any other pnpm failure through untouched', async () => {
    const dev = makeDev()
    vi.mocked(runPnpm).mockResolvedValue({ ok: false, text: 'ERR_PNPM_RECURSIVE_INSTALL_FIRST  Run a plain pnpm install' })
    const r = await packDevPackage(dev, store())
    expect(r.ok).toBe(false)
    expect(r.needsInstall).toBeUndefined()
    expect(r.text).toBe('ERR_PNPM_RECURSIVE_INSTALL_FIRST  Run a plain pnpm install')
  })

  it('refuses without a store, and without a readable name', async () => {
    const dev = makeDev()
    expect((await packDevPackage(dev, '')).ok).toBe(false)
    mkdirSync(devDir(), { recursive: true })
    writeFileSync(join(devDir(), 'package.json'), JSON.stringify({ version: '0.1.0' }))
    expect((await packDevPackage(dev, store())).ok).toBe(false)
    expect(runPnpm).not.toHaveBeenCalled()
  })
})
