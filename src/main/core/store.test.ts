/**
 * Store install / uninstall failure branches. `plugins.test.ts` exercises the
 * happy path against real pnpm; here we mock `runPnpm` so every guard-and-fail
 * branch in `store-install` / `store-uninstall` is covered deterministically.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSource, addPlugin } from './store-install.ts'
import { removePlugin, deleteTreePhysical } from './store-uninstall.ts'
import { migrateStore, needsStoreMigration } from './store-migration.ts'

const { runPnpmMock } = vi.hoisted(() => ({
  runPnpmMock: vi.fn(),
}))
vi.mock('./pnpm.ts', async () => {
  const actual = await vi.importActual<typeof import('./pnpm.ts')>('./pnpm.ts')
  return { ...actual, runPnpm: runPnpmMock }
})

function tmpStore(): string {
  return mkdtempSync(join(tmpdir(), 'pm-store-'))
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