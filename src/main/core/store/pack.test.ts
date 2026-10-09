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
const packDest = (version = '0.1.0', name = '@me/dsh-foo'): string => packDir(store(), name, version)

/** A registered dev plugin whose manifest is already on disk. */
function makeDev(manifest: Record<string, unknown> = {}): DevPlugin {
  mkdirSync(devDir(), { recursive: true })
  writeFileSync(join(devDir(), 'package.json'), JSON.stringify({ name: '@me/dsh-foo', version: '0.1.0', ...manifest }))
  return { name: '@me/dsh-foo', dir: devDir(), bundle: false, addedAt: '2026-01-01T00:00:00.000Z' }
}

/** A pack run that leaves `file` where pnpm would: in the destination it was
 * handed, which the launcher must not re-derive. */
function mockPackWriting(file: string): void {
  vi.mocked(runPnpm).mockImplementation(async (_dir, args) => {
    writeFileSync(join(args[2] as string, file), '')
    return { ok: true, text: 'packed', command: 'pnpm pack' }
  })
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-pack-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  vi.mocked(runPnpm).mockReset()
})

describe('packDevPackage', () => {
  it('packs in the dev repo with no launcher store injected, into a per-version dir', async () => {
    const dev = makeDev()
    // pnpm names the tarball itself; the launcher must not predict it.
    mockPackWriting('deepseek-ai-dsh-foo-0.1.0.tgz')
    const r = await packDevPackage(dev, store())
    expect(r.ok).toBe(true)
    expect(r.tgz).toBe(join(packDest(), 'deepseek-ai-dsh-foo-0.1.0.tgz'))
    // The user's repo keeps its own pnpm store —injecting the launcher's would
    // fight whatever that repo is configured to do.
    expect(runPnpm).toHaveBeenCalledWith(
      devDir(), ['pack', '--pack-destination', packDest()], undefined, { skipStoreDir: true },
    )
  })

  it('keeps the tarball: the archive re-resolves its file: dependency through it', async () => {
    const dev = makeDev()
    mockPackWriting('x.tgz')
    await packDevPackage(dev, store())
    expect(readdirSync(packDest())).toEqual(['x.tgz'])
  })

  it('keeps every other version\'s tarball, so an older archive stays repairable', async () => {
    // The archive records `file:<tarball>` as its own dependency, and a repair or
    // rebuild of an archived version re-resolves through it. One directory per
    // PACKAGE meant a version bump deleted the previous tarball and that version
    // could never be built again.
    const dev = makeDev({ version: '1.0.0' })
    mockPackWriting('foo-1.0.0.tgz')
    expect((await packDevPackage(dev, store())).ok).toBe(true)

    const bumped = makeDev({ version: '1.1.0' })
    mockPackWriting('foo-1.1.0.tgz')
    expect((await packDevPackage(bumped, store())).ok).toBe(true)

    expect(readdirSync(packDest('1.0.0'))).toEqual(['foo-1.0.0.tgz'])
    expect(readdirSync(packDest('1.1.0'))).toEqual(['foo-1.1.0.tgz'])
  })

  it('still replaces the tarball of the SAME version', async () => {
    // Same version, source moved on: keeping the old tarball would report success
    // while storing the previous state, and the old one is what the archive wants
    // to be replaced by.
    const dev = makeDev({ version: '1.0.0' })
    mockPackWriting('stale.tgz')
    await packDevPackage(dev, store())
    mockPackWriting('fresh.tgz')
    await packDevPackage(makeDev({ version: '1.0.0' }), store())
    expect(readdirSync(packDest('1.0.0'))).toEqual(['fresh.tgz'])
  })

  it('replaces a stale tarball from an earlier run rather than reading it as this one', async () => {
    const dev = makeDev()
    const dest = packDest()
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
    expect(existsSync(packDest())).toBe(false)
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

  it('refuses a package name that would put the pack dir outside the store', async () => {
    // `dest` is recursively removed just before the pack, so an escaping name is
    // the difference between clearing a stale tarball and deleting a directory
    // the user did not name. The dev package's OWN manifest supplies it.
    const dev = makeDev({ name: '../evil' })
    const r = await packDevPackage(dev, store())
    expect(r.ok).toBe(false)
    expect(r.text).toContain('包名不合法')
    expect(runPnpm).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'evil'))).toBe(false)
  })

  it('refuses a version that would put the pack dir outside the store', async () => {
    // The version became a path segment when tarballs moved to one directory per
    // version, and that directory is recursively removed — the same hazard as the
    // name, from the same untrusted manifest. The pack itself is mocked to
    // SUCCEED, so what this test observes is the guard rather than a mock artifact.
    mockPackWriting('x.tgz')
    for (const version of ['..', '../evil', '1/2', '']) {
      const dev = makeDev({ version })
      const r = await packDevPackage(dev, store())
      expect(r.ok, `version=${version}`).toBe(false)
      expect(r.text, `version=${version}`).toContain('版本号不可用')
      expect(runPnpm, `version=${version}`).not.toHaveBeenCalled()
    }
    expect(existsSync(join(root, 'evil'))).toBe(false)
    // An empty version must NOT collapse back to the all-versions directory.
    expect(existsSync(join(store(), '.pack', '@me', 'dsh-foo'))).toBe(false)
  })

  it('keeps a scoped name inside the store, nested as pnpm lays it out', async () => {
    const dev = makeDev({ name: '@scope/pkg' })
    mockPackWriting('x.tgz')
    const r = await packDevPackage(dev, store())
    expect(r.ok).toBe(true)
    expect(r.tgz).toBe(join(store(), '.pack', '@scope', 'pkg', '0.1.0', 'x.tgz'))
  })
})
