/**
 * Profile lifecycle: create/clone/soft-delete, bundle reorder/remove, export
 * classification and import. `runPnpm` + the plugin-store install helpers are
 * mocked; FS helpers run against a disposable tree with a fake active dsh.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* pnpm installs and store downloads are stubbed so imports stay offline. */
vi.mock('./pnpm.ts', async (importActual) => {
  const actual = await importActual<typeof import('./pnpm.ts')>()
  return { ...actual, runPnpm: vi.fn() }
})
vi.mock('./plugins.ts', async (importActual) => {
  const actual = await importActual<typeof import('./plugins.ts')>()
  return {
    ...actual,
    addLocalPlugin: vi.fn(),
    addPlugin: vi.fn(),
    installIntoProfile: vi.fn(),
  }
})
import { runPnpm } from './pnpm.ts'
import { addLocalPlugin, addPlugin, installIntoProfile } from './plugins.ts'
import { openDatabase, saveSettings } from './settings.ts'
import {
  activeDshVersion, cloneProfile, createProfile, exportProfile, importProfile,
  listLocalBundles, listProfileSummaries, removeBundle, reorderBundle, softDeleteProfile,
} from './profile.ts'

let root: string
const home = (): string => join(root, 'home')
const profiles = (): string => join(home(), 'profiles')
const store = (): string => join(root, 'store')

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-profile-'))
  await openDatabase(join(root, 'app.sqlite'))
  saveSettings({
    activeDshId: 'a',
    dshes: [{ id: 'a', name: 'dsh@a', execPath: '/fake/a', version: '1.0.0', home: home() }],
    pluginDir: store(),
  })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(profiles(), { recursive: true })
  mkdirSync(store(), { recursive: true })
  vi.mocked(runPnpm).mockReset()
  vi.mocked(runPnpm).mockResolvedValue({ ok: true, text: 'Done in 1ms' })
  vi.mocked(addPlugin).mockReset()
  vi.mocked(addPlugin).mockResolvedValue({ ok: true, text: 'added' })
  vi.mocked(addLocalPlugin).mockReset()
  vi.mocked(addLocalPlugin).mockResolvedValue({ ok: true, text: 'added local' })
  vi.mocked(installIntoProfile).mockReset()
  vi.mocked(installIntoProfile).mockResolvedValue({ ok: true, text: 'linked', activated: true })
  // Reset the persisted settings baseline so mutations in prior tests never leak.
  saveSettings({
    activeDshId: 'a',
    dshes: [{ id: 'a', name: 'dsh@a', execPath: '/fake/a', version: '1.0.0', home: home() }],
    pluginDir: store(),
  })
})

describe('createProfile', () => {
  it('writes a base manifest, patch and pnpm workspace', () => {
    createProfile('base')
    const m = JSON.parse(readFileSync(join(profiles(), 'base', 'package.json'), 'utf8'))
    expect(m.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(existsSync(join(profiles(), 'base', 'cordis.patch.yml'))).toBe(true)
    expect(existsSync(join(profiles(), 'base', 'pnpm-workspace.yaml'))).toBe(true)
  })

  it('accepts a custom bundle template and rejects bad names / duplicates', () => {
    createProfile('web', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(() => createProfile('Bad Name')).toThrow(/kebab-case/)
    expect(() => createProfile('web')).toThrow(/already exists/)
  })
})

describe('cloneProfile', () => {
  it('copies config without node_modules', () => {
    createProfile('src')
    const nm = join(profiles(), 'src', 'node_modules')
    mkdirSync(join(nm, 'x'), { recursive: true })
    writeFileSync(join(nm, 'x', 'f'), '')
    cloneProfile('src', 'dst')
    expect(existsSync(join(profiles(), 'dst', 'package.json'))).toBe(true)
    expect(existsSync(join(profiles(), 'dst', 'node_modules'))).toBe(false)
  })

  it('rejects missing source and invalid target', () => {
    expect(() => cloneProfile('ghost', 'dst')).toThrow(/not found/)
    expect(() => cloneProfile('src', 'Bad')).toThrow(/kebab-case/)
  })
})

describe('softDeleteProfile', () => {
  it('moves the profile into .trash', () => {
    createProfile('gone')
    softDeleteProfile('gone')
    expect(existsSync(join(profiles(), 'gone'))).toBe(false)
    expect(existsSync(join(profiles(), '.trash', 'gone'))).toBe(true)
  })

  it('auto-numbers a colliding trash name', () => {
    createProfile('dup')
    softDeleteProfile('dup')
    createProfile('dup')
    softDeleteProfile('dup')
    expect(existsSync(join(profiles(), '.trash', 'dup (2)'))).toBe(true)
  })
})

describe('removeBundle / reorderBundle', () => {
  it('removeBundle drops the layer and prunes with pnpm install', async () => {
    createProfile('p')
    const mp = join(profiles(), 'p', 'package.json')
    writeFileSync(mp, JSON.stringify({ dsh: { profile: { bundles: ['a', 'b'] } }, dependencies: { a: 'link:/x' } }))
    await removeBundle('p', 'a')
    const m = JSON.parse(readFileSync(mp, 'utf8'))
    expect(m.dsh.profile.bundles).toEqual(['b'])
    expect(m.dependencies).toEqual({})
    expect(runPnpm).toHaveBeenCalledWith(join(profiles(), 'p'), ['install', '--config.confirmModulesPurge=false'])
  })

  it('removeBundle throws when the bundle is absent', async () => {
    createProfile('p')
    await expect(removeBundle('p', 'nope')).rejects.toThrow(/没有 bundle/)
  })

  it('reorderBundle moves and clamps the index', () => {
    createProfile('p')
    const mp = join(profiles(), 'p', 'package.json')
    writeFileSync(mp, JSON.stringify({ dsh: { profile: { bundles: ['a', 'b', 'c'] } } }))
    reorderBundle('p', 'a', 2)
    expect(JSON.parse(readFileSync(mp, 'utf8')).dsh.profile.bundles).toEqual(['b', 'c', 'a'])
    reorderBundle('p', 'c', 99)
    expect(JSON.parse(readFileSync(mp, 'utf8')).dsh.profile.bundles).toEqual(['b', 'a', 'c'])
  })
})

describe('activeDshVersion', () => {
  it('returns the active version, then "" when none is set', () => {
    expect(activeDshVersion()).toBe('1.0.0')
    saveSettings({ dshes: [], activeDshId: undefined })
    expect(activeDshVersion()).toBe('')
    saveSettings({
      activeDshId: 'a',
      dshes: [{ id: 'a', name: 'a', execPath: '/a', version: '2.0.0', home: home() }],
    })
    expect(activeDshVersion()).toBe('2.0.0')
  })
})

describe('exportProfile', () => {
  it('classifies bundles by source and strips link/file deps', () => {
    createProfile('exp')
    writeFileSync(join(profiles(), 'exp', 'package.json'), JSON.stringify({
      name: 'dsh-profile-exp',
      dependencies: { npmA: '^1.0.0', locA: 'link:/x', plain: '^2.0.0' },
      dsh: { profile: { bundles: ['tpl', 'npmA', 'locA'] } },
    }))
    // locA is a real local plugin iff the store records a file:/link: dep for it.
    writeFileSync(join(store(), 'package.json'), JSON.stringify({ dependencies: { locA: 'link:/x' } }))
    const out = JSON.parse(exportProfile('exp'))
    expect(out.schemaVersion).toBe(2)
    expect(out.bundles).toEqual([
      { name: 'tpl', source: 'dsh' },
      { name: 'npmA', source: 'npm', spec: '^1.0.0' },
      { name: 'locA', source: 'local' },
    ])
    // only non-bundle npm deps survive
    expect(out.dependencies).toEqual({ plain: '^2.0.0' })
  })
})

describe('listLocalBundles', () => {
  it('returns locally-linked bundles whose store dir exists', () => {
    createProfile('p')
    writeFileSync(join(profiles(), 'p', 'package.json'), JSON.stringify({
      dependencies: { locA: 'link:/x', npmA: '^1.0.0' },
      dsh: { profile: { bundles: ['locA', 'npmA'] } },
    }))
    writeFileSync(join(store(), 'package.json'), JSON.stringify({ dependencies: { locA: 'link:/x' } }))
    const locDir = join(store(), 'node_modules', 'locA')
    mkdirSync(locDir, { recursive: true })
    writeFileSync(join(locDir, 'package.json'), '{}')
    const r = listLocalBundles('p', store())
    expect(r).toEqual([{ name: 'locA', dir: locDir }])
  })
})

describe('importProfile', () => {
  it('rejects non-object / invalid input and a fresh-name clash', async () => {
    await expect(importProfile('null')).rejects.toThrow(/不是对象/)
    await expect(importProfile('["x"]')).rejects.toThrow(/不是对象/)
    createProfile('taken')
    const good = JSON.stringify({ name: 'taken', bundles: [], dependencies: {}, userPatch: '' })
    await expect(importProfile(good)).rejects.toThrow(/already exists/)
  })

  it('refuses on a dsh major mismatch unless forced', async () => {
    const payload = JSON.stringify({ name: 'nou', dshVersion: '9.0.0', bundles: [], dependencies: {} })
    const r = await importProfile(payload, { name: 'nou' })
    expect(r.ok).toBe(false)
    expect('dshMismatch' in r && r.dshMismatch === true).toBe(true)
  })

  it('imports in-box dsh bundles without any store install', async () => {
    const payload = JSON.stringify({
      dshVersion: '1.0.0', bundles: [{ name: 'tpl', source: 'dsh' }], dependencies: {}, userPatch: '',
    })
    const r = await importProfile(payload, { name: 'baseonly' })
    expect(r.ok).toBe(true)
    expect('installed' in r && r.installed).toEqual([])
    expect(runPnpm).toHaveBeenCalledWith(join(profiles(), 'baseonly'), ['install', '--config.confirmModulesPurge=false'])
  })

  it('reuses an existing store version when it satisfies the range', async () => {
    const pkgDir = join(store(), 'archive', 'npmA', '1.2.0', 'node_modules', 'npmA')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ version: '1.2.0' }))
    const payload = JSON.stringify({
      dshVersion: '1.0.0', bundles: [{ name: 'npmA', source: 'npm', spec: '^1.0.0' }], dependencies: {},
    })
    const r = await importProfile(payload, { name: 'reuse' })
    expect(addPlugin).not.toHaveBeenCalled()
    expect(installIntoProfile).toHaveBeenCalledWith('reuse', 'npmA', store())
    expect('installed' in r && r.installed).toEqual(['npmA'])
  })

  it('downloads from npm when no store version is usable', async () => {
    const payload = JSON.stringify({
      dshVersion: '1.0.0', bundles: [{ name: 'fresh', source: 'npm', spec: '^3.0.0' }], dependencies: {},
    })
    const r = await importProfile(payload, { name: 'dl' })
    expect(addPlugin).toHaveBeenCalledWith(store(), 'fresh@^3.0.0')
    expect('ok' in r && r.ok).toBe(true)
  })

  it('installs a local bundle from an offline source', async () => {
    const offline = join(root, 'bundle-src', 'locB')
    mkdirSync(offline, { recursive: true })
    writeFileSync(join(offline, 'package.json'), '{}')
    const payload = JSON.stringify({
      dshVersion: '1.0.0', bundles: [{ name: 'locB', source: 'local' }], dependencies: {},
    })
    const r = await importProfile(payload, { name: 'offline', localSource: join(root, 'bundle-src') })
    expect(addLocalPlugin).toHaveBeenCalled()
    expect('ok' in r && r.ok).toBe(true)
  })

  it('reports a bundle as missing when the store install fails', async () => {
    vi.mocked(addPlugin).mockResolvedValueOnce({ ok: false, text: 'registry down' })
    const payload = JSON.stringify({
      dshVersion: '1.0.0', bundles: [{ name: 'flake', source: 'npm', spec: '^1.0.0' }], dependencies: {},
    })
    const r = await importProfile(payload, { name: 'flakey' })
    expect(r).toMatchObject({ ok: true, installed: [], missing: ['flake'] })
  })
})