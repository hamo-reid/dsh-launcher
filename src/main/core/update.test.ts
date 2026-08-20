/** Tests for the in-place dsh update path: `checkForDshUpdate` (mocking the npm
 * registry), the version-repo sub-name probe, and the update's managed-install
 * guard. No real network or dsh needed. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('./npm.ts', () => ({
  fetchPackageVersions: vi.fn(),
}))

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchPackageVersions } from './npm.ts'
import { checkForDshUpdate, installSubName, updateDsh, type DshEntry } from './dsh.ts'

const mockFetch = fetchPackageVersions as unknown as ReturnType<typeof vi.fn>

let root: string

function entry(patch: Partial<DshEntry>): DshEntry {
  return {
    id: 'x', name: 'official', execPath: join(root, 'dl', 'official', 'node_modules', '.bin', 'dsh.cmd'),
    version: '1.0.0', home: join(root, 'homes', 'official'), managed: true, versionDir: join(root, 'dl'),
    ...patch,
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pm-update-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('checkForDshUpdate', () => {
  const setTags = (distTags: Record<string, string>, versions: string[] = []): void => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(() => Promise.resolve({ distTags, versions }))
  }
  const setLatest = (latest: string, versions: string[] = []): void => setTags({ latest }, versions)

  it('reports a newer stable major', async () => {
    setLatest('2.0.0', ['1.0.0', '2.0.0'])
    expect(await checkForDshUpdate('1.0.0')).toEqual({
      current: '1.0.0', latest: { version: '2.0.0', majorBump: true },
    })
  })

  it('reports a stable patch bump without majorBump', async () => {
    setLatest('1.0.1', ['1.0.1'])
    expect(await checkForDshUpdate('1.0.0')).toEqual({
      current: '1.0.0', latest: { version: '1.0.1', majorBump: false },
    })
  })

  it('offers the next prerelease track when already on latest stable', async () => {
    // current == latest stable, but a next prerelease exists → a next track only.
    setTags({ latest: '1.0.0', next: '1.1.0-beta.1' }, ['1.0.0', '1.1.0-beta.1'])
    expect(await checkForDshUpdate('1.0.0')).toEqual({
      current: '1.0.0', next: { version: '1.1.0-beta.1', majorBump: false },
    })
  })

  it('offers both tracks when both are newer', async () => {
    setTags({ latest: '1.0.1', next: '2.0.0-beta.1' }, ['1.0.0', '1.0.1', '2.0.0-beta.1'])
    expect(await checkForDshUpdate('1.0.0')).toEqual({
      current: '1.0.0',
      latest: { version: '1.0.1', majorBump: false },
      next: { version: '2.0.0-beta.1', majorBump: true },
    })
  })

  it('returns null when already on the latest stable (no next)', async () => {
    setLatest('1.0.0', ['1.0.0'])
    expect(await checkForDshUpdate('1.0.0')).toBeNull()
  })

  it('returns null when the current version is blank', async () => {
    setLatest('2.0.0', ['2.0.0'])
    expect(await checkForDshUpdate('')).toBeNull()
  })

  it('returns null when no latest or next tag is resolvable', async () => {
    setTags({}, [])
    expect(await checkForDshUpdate('1.0.0')).toBeNull()
  })
})

describe('installSubName', () => {
  it('returns the version-repo subdir owning the executable', () => {
    const dl = join(root, 'dl')
    const sub = join(dl, 'official')
    mkdirSync(sub, { recursive: true })
    const e = entry({ execPath: join(sub, 'node_modules', '.bin', 'dsh.cmd') })
    expect(installSubName(e, dl)).toBe('official')
  })

  it('returns "" when the executable is not under the root', () => {
    const dl = join(root, 'dl2')
    mkdirSync(dl, { recursive: true })
    const e = entry({ execPath: join(dl, 'elsewhere', 'dsh') })
    expect(installSubName(e, dl)).toBe('')
  })
})

describe('updateDsh guard', () => {
  it('refuses a non-app-managed install (exec outside the repo) before touching anything', async () => {
    const e = entry({ managed: false, versionDir: undefined, execPath: join(root, 'elsewhere', 'dsh') })
    await expect(updateDsh(e, join(root, 'dl'))).rejects.toThrow(/无法更新/)
  })

  it('refuses when the install dir is not in the version repo', async () => {
    const e = entry({ execPath: join(root, 'elsewhere', 'dsh') })
    await expect(updateDsh(e, join(root, 'dl'))).rejects.toThrow('无法定位')
  })
})