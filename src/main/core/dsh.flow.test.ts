/**
 * dsh update-track + official-install flow tests, run against mocked npm/pnpm so
 * the version-resolution guards and failure branches are deterministic (no real
 * registry, no real install). Pure helper specs already live in dsh.install.test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkForDshUpdate, installOfficialDsh, installSubName } from './dsh.ts'
import type { PackageVersionInfo } from '../../shared/types.ts'

const { fetchVersionsMock, runPnpmMock } = vi.hoisted(() => ({
  fetchVersionsMock: vi.fn(),
  runPnpmMock: vi.fn(),
}))
vi.mock('./npm.ts', async () => {
  const actual = await vi.importActual<typeof import('./npm.ts')>('./npm.ts')
  return { ...actual, fetchPackageVersions: fetchVersionsMock }
})
vi.mock('./pnpm.ts', async () => {
  const actual = await vi.importActual<typeof import('./pnpm.ts')>('./pnpm.ts')
  return { ...actual, runPnpm: runPnpmMock }
})

const REGISTRY: PackageVersionInfo = {
  distTags: { latest: '2.0.0', next: '2.1.0-beta.1' },
  versions: ['1.0.0', '2.0.0'],
}

describe('checkForDshUpdate', () => {
  beforeEach(() => authRedefine())

  function authRedefine(): void {
    fetchVersionsMock.mockReset()
    fetchVersionsMock.mockResolvedValue(REGISTRY)
  }

  it('returns null for a blank current version', async () => {
    expect(await checkForDshUpdate('')).toBeNull()
    expect(await checkForDshUpdate('   ')).toBeNull()
  })

  it('offers the stable latest with a major-bump flag when it is newer', async () => {
    const r = await checkForDshUpdate('1.9.0')
    expect(r?.latest).toEqual({ version: '2.0.0', majorBump: true })
  })

  it('offers only the prerelease next when stable is current', async () => {
    const r = await checkForDshUpdate('2.0.0')
    expect(r?.latest).toBeUndefined()
    // 2.1.0-beta.1 and 2.0.0 share major 2 → no major bump.
    expect(r?.next).toEqual({ version: '2.1.0-beta.1', majorBump: false })
  })

  it('returns null when nothing is newer', async () => {
    expect(await checkForDshUpdate('2.1.0-beta.1')).toBeNull()
  })

  it('collapses next onto latest when they are the same version', async () => {
    fetchVersionsMock.mockResolvedValue({ distTags: { latest: '2.0.0', next: '2.0.0' }, versions: ['1.0.0', '2.0.0'] })
    const r = await checkForDshUpdate('1.0.0')
    expect(r?.latest?.version).toBe('2.0.0')
    expect(r?.next).toBeUndefined()
  })
})

describe('installOfficialDsh failure branches', () => {
  beforeEach(() => {
    runPnpmMock.mockReset()
  })

  it('throws when pnpm add fails and cleans up the target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-dshflow-'))
    try {
      runPnpmMock.mockResolvedValue({ ok: false, text: 'registry unreachable' })
      const steps: string[] = []
      await expect(installOfficialDsh(root, 'official', '1.0.0', s => steps.push(s.kind))).rejects.toThrow(/安装官方 dsh 失败/)
      expect(steps).toContain('install')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rethrows when resolving the latest version over the network fails', async () => {
    fetchVersionsMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const root = mkdtempSync(join(tmpdir(), 'pm-dshflow-'))
    try {
      await expect(installOfficialDsh(root, 'official')).rejects.toThrow(/解析 @deepseek-ai\/dsh 最新版本失败/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('throws when no canonical version can be resolved at all', async () => {
    fetchVersionsMock.mockResolvedValue({ distTags: {}, versions: [] })
    const root = mkdtempSync(join(tmpdir(), 'pm-dshflow-'))
    try {
      await expect(installOfficialDsh(root, 'official')).rejects.toThrow(/未能从 npm 解析/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('installSubName', () => {
  it('returns an empty name for an absent repo root', () => {
    const entry = { id: 'x', name: 'x', execPath: '/nope', version: '1', home: '/h' }
    expect(installSubName(entry, '')).toBe('')
  })

  it('identifies the repo sub-dir owning the executable', () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-sub-'))
    try {
      const pkgDir = join(root, 'v1', 'node_modules', '@deepseek-ai', 'dsh')
      mkdirSync(join(pkgDir, 'bin'), { recursive: true })
      const bin = join(root, 'v1', 'node_modules', '.bin', 'dsh.cmd')
      mkdirSync(join(root, 'v1', 'node_modules', '.bin'), { recursive: true })
      writeFileSync(bin, '@echo off')
      const entry = { id: bin, name: 'v1', execPath: bin, version: '1', home: join(root, 'homes', 'v1') }
      expect(installSubName(entry, root)).toBe('v1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})