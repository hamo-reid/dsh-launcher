/**
 * Store install / uninstall failure branches. `plugins.test.ts` exercises the
 * happy path against real pnpm; here we mock `runPnpm` so every guard-and-fail
 * branch in `store-install` / `store-uninstall` is covered deterministically.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSource, addPlugin } from './install.ts'
import { removePlugin, deleteTreePhysical } from './uninstall.ts'
import { migrateStore, needsStoreMigration } from './migration.ts'

const { runPnpmMock } = vi.hoisted(() => ({
  runPnpmMock: vi.fn(),
}))
vi.mock('../dsh/pnpm.ts', async () => {
  const actual = await vi.importActual<typeof import('../dsh/pnpm.ts')>('../dsh/pnpm.ts')
  return { ...actual, runPnpm: runPnpmMock }
})

function tmpStore(): string {
  return mkdtempSync(join(tmpdir(), 'pm-store-'))
}

/** Make the mocked `pnpm add` leave a package body behind with `version` in its
 * manifest — the only place `installSource` learns the version from, and the
 * field a `github:`/zip/folder source controls itself. */
function mockAddWithVersion(version: string, name = 'foo'): void {
  runPnpmMock.mockImplementation(async (dir: string) => {
    const body = join(dir, 'node_modules', name)
    mkdirSync(body, { recursive: true })
    writeFileSync(join(body, 'package.json'), JSON.stringify({ name, version }))
    return { ok: true, text: 'added 1' }
  })
}

/** A minimal "already archived" state a version string could damage. */
function seedArchive(store: string): string {
  const keep = join(store, 'archive', 'foo', '1.0.0', 'keep.txt')
  mkdirSync(join(store, 'archive', 'foo', '1.0.0'), { recursive: true })
  writeFileSync(keep, 'archived body')
  mkdirSync(join(store, '.trash'), { recursive: true })
  writeFileSync(join(store, '.trash', 'note.txt'), 'stashed body')
  return keep
}

describe('installSource guard branches', () => {
  beforeEach(() => {
    runPnpmMock.mockReset()
    runPnpmMock.mockImplementation(async () => ({ ok: true, text: '' }))
  })

  it('refuses an empty plugin name before touching pnpm', async () => {
    const store = tmpStore()
    try {
      const r = await installSource(store, '   ', 'anything')
      expect(r.ok).toBe(false)
      expect(runPnpmMock).not.toHaveBeenCalled()
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  it('refuses a path-escaping plugin name before touching disk or pnpm', async () => {
    const store = tmpStore()
    try {
      // `.` and longer dot runs name an existing ancestor: a name of `.` makes
      // `archive/<name>/<version>` collapse back to `archive/`, which the
      // replace path would then move into `.trash` and delete recursively.
      for (const name of ['..', '../evil', 'a/b/../c', 'a\\b', 'C:\\x', '/abs', '.', '...']) {
        const r = await installSource(store, name, 'anything')
        expect(r.ok, `name=${name}`).toBe(false)
      }
      expect(runPnpmMock).not.toHaveBeenCalled()
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  it('refuses a source that pnpm would parse as a flag', async () => {
    const store = tmpStore()
    try {
      const r = await installSource(store, 'foo', '--global')
      expect(r.ok).toBe(false)
      expect(runPnpmMock).not.toHaveBeenCalled()
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  it('propagates a failed pnpm add and drops the staging dir', async () => {
    const store = tmpStore()
    try {
      runPnpmMock.mockResolvedValue({ ok: false, text: 'boom' })
      const r = await installSource(store, 'foo', 'foo@1')
      expect(r.ok).toBe(false)
      expect(r.text).toBe('boom')
      expect(existsSync(join(store, 'archive', 'foo', '.staging'))).toBe(false)
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  it('treats a reported-success install that never landed as a failure', async () => {
    const store = tmpStore()
    try {
      runPnpmMock.mockResolvedValue({ ok: true, text: 'added 1' })
      const r = await installSource(store, 'foo', 'foo@1')
      expect(r.ok).toBe(false)
      expect(r.text).toContain('未在 node_modules 中找到 foo')
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  it('addPlugin refuses an unconfigured store dir', async () => {
    const r = await addPlugin('', 'foo@1')
    expect(r.ok).toBe(false)
  })

  it('refuses a package-declared version that would escape the version dir', async () => {
    // A registry source is semver-enforced by the registry; a `github:`/zip/folder
    // package declares its own version. `..` is the sharp one: with replace=true
    // the dest is renamed into `.trash` and deleted recursively, so a
    // package-declared version could delete a whole plugin's archive. `''`
    // collapses `archive/foo/''` back to `archive/foo` — the plugin dir itself.
    for (const version of ['..', '../x', '1/2', '1\\2', 'C:evil', 'a..b', '']) {
      const store = tmpStore()
      try {
        const keep = seedArchive(store)
        mockAddWithVersion(version)
        const r = await installSource(store, 'foo', 'file:whatever')
        expect(r.ok, `version=${version}`).toBe(false)
        expect(r.text, `version=${version}`).toContain('版本号不可用')
        // Nothing outside, nothing lost inside, and no staging left behind.
        expect(existsSync(keep), `version=${version}`).toBe(true)
        expect(existsSync(join(store, 'archive', 'x')), `version=${version}`).toBe(false)
        expect(existsSync(join(store, '.trash', 'note.txt')), `version=${version}`).toBe(true)
        expect(existsSync(join(store, 'archive', 'foo', '.staging')), `version=${version}`).toBe(false)
      } finally {
        rmSync(store, { recursive: true, force: true })
      }
    }
  })

  it('refuses the same escape under replace, where it would delete the archive', async () => {
    const store = tmpStore()
    try {
      const keep = seedArchive(store)
      mockAddWithVersion('..')
      const r = await installSource(store, 'foo', 'file:whatever', undefined, { replace: true })
      expect(r.ok).toBe(false)
      expect(existsSync(keep)).toBe(true)
      expect(existsSync(join(store, '.trash', 'note.txt'))).toBe(true)
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  it('still archives a legal version, and reports the version it archived', async () => {
    for (const version of ['2.1.0-beta.1', '1.0.0+build.7']) {
      const store = tmpStore()
      try {
        mockAddWithVersion(version)
        const r = await installSource(store, 'foo', 'file:whatever')
        expect(r.ok, `version=${version}`).toBe(true)
        expect(r.version, `version=${version}`).toBe(version)
        expect(
          existsSync(join(store, 'archive', 'foo', version, 'node_modules', 'foo', 'package.json')),
          `version=${version}`,
        ).toBe(true)
      } finally {
        rmSync(store, { recursive: true, force: true })
      }
    }
  })

  it('reports the archived version on the already-present no-op too', async () => {
    const store = tmpStore()
    try {
      mockAddWithVersion('1.0.0')
      await installSource(store, 'foo', 'file:whatever')
      const again = await installSource(store, 'foo', 'file:whatever')
      expect(again.ok).toBe(true)
      expect(again.text).toContain('已在该版本')
      expect(again.version).toBe('1.0.0')
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })
})

describe('removePlugin guard branches', () => {
  it('reports a non-archived plugin as missing', () => {
    const store = tmpStore()
    try {
      const r = removePlugin(store, 'ghost')
      expect(r.ok).toBe(false)
      expect(r.text).toContain('未在插件库中')
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  it('removePlugin refuses an unconfigured store dir', () => {
    const r = removePlugin('', 'ghost')
    expect(r.ok).toBe(false)
  })

  it('deleteTreePhysical tolerates a missing dir (falls back to rm force)', () => {
    expect(() => deleteTreePhysical(join(tmpdir(), 'does-not-exist-xyz'))).not.toThrow()
  })

  it('refuses a dot-only version instead of deleting the archive', () => {
    const store = tmpStore()
    try {
      const archive = join(store, 'archive')
      mkdirSync(archive, { recursive: true })
      const marker = join(archive, 'keep.txt')
      writeFileSync(marker, 'x')

      expect(removePlugin(store, 'pkg', '..').ok).toBe(false)
      expect(removePlugin(store, 'pkg', '.').ok).toBe(false)
      // The archive (and its content) must survive the refused calls.
      expect(existsSync(marker)).toBe(true)
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })
})

describe('store-migration failure branches', () => {
  beforeEach(() => {
    runPnpmMock.mockReset()
    runPnpmMock.mockImplementation(async () => ({ ok: true, text: '' }))
  })

  it('needsStoreMigration is false when the store has no manifest', () => {
    const store = tmpStore()
    try {
      expect(needsStoreMigration(store)).toBe(false)
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  it('migrateStore is a no-op when the store has no legacy manifest', async () => {
    const store = tmpStore()
    try {
      await expect(migrateStore(store)).resolves.toBeUndefined()
      expect(runPnpmMock).not.toHaveBeenCalled()
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  it('skips a legacy package whose offline and online reinstall both fail', async () => {
    const store = tmpStore()
    try {
      mkdirSync(join(store, 'node_modules', 'occ'), { recursive: true })
      writeFileSync(join(store, 'node_modules', 'occ', 'package.json'), JSON.stringify({ name: 'occ', version: '1.0.0' }))
      writeFileSync(join(store, 'package.json'), JSON.stringify({ dependencies: { occ: '1.0.0' } }))
      runPnpmMock.mockImplementation(async () => ({ ok: false, text: 'offline miss' }))
      // The offline add and the online retry both fail → the package is skipped,
      // no version lands, but migrateStore resolves without throwing.
      await expect(migrateStore(store)).resolves.toBeUndefined()
      expect(runPnpmMock).toHaveBeenCalled()
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })
})