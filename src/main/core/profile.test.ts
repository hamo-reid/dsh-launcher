/**
 * Profile lifecycle: create/clone/soft-delete, bundle reorder/remove, export
 * classification and import. `runPnpm` + the plugin-store install helpers are
 * mocked; FS helpers run against a disposable tree with an explicit dsh context.
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
import { contextForEntry } from './appState.ts'
import {
  addBundle, cloneProfile, createProfile, exportProfile, importProfile,
  listLocalBundles, listProfileSummaries, readProfileFile, removeBundle, removeDependency, renameProfile,
  reorderBundle, setDependency, setManifestMeta, softDeleteProfile, writeProfileFile,
} from './profile.ts'

let root: string
const home = (): string => join(root, 'home')
const profiles = (): string => join(home(), 'profiles')
const store = (): string => join(root, 'store')
const ctx = (): ReturnType<typeof contextForEntry> =>
  contextForEntry({ id: 'a', name: 'dsh@a', execPath: '/fake/a', version: '1.0.0', home: home() })

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-profile-'))
  await openDatabase(join(root, 'app.sqlite'))
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
  saveSettings({ dshes: [], pluginDir: store() })
})

describe('createProfile', () => {
  it('writes a base manifest, patch and pnpm workspace', () => {
    createProfile(ctx(), 'base')
    const m = JSON.parse(readFileSync(join(profiles(), 'base', 'package.json'), 'utf8'))
    expect(m.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
    // The host's custom-profile default, written so the manifest is explicit.
    expect(m.dsh.profile.patchReload).toBe('live')
    expect(existsSync(join(profiles(), 'base', 'cordis.patch.yml'))).toBe(true)
    expect(existsSync(join(profiles(), 'base', 'pnpm-workspace.yaml'))).toBe(true)
  })

  it('accepts a custom bundle template and rejects bad names / duplicates', () => {
    createProfile(ctx(), 'myweb', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(() => createProfile(ctx(), 'Bad Name')).toThrow(/kebab-case/)
    expect(() => createProfile(ctx(), 'myweb')).toThrow(/already exists/)
  })

  it('refuses a name the host reserves for a shipped template', () => {
    expect(() => createProfile(ctx(), 'web')).toThrow(/reserved/)
    expect(() => cloneProfile(ctx(), 'base', 'headless')).toThrow(/reserved/)
  })
})

describe('cloneProfile', () => {
  it('copies config without node_modules', () => {
    createProfile(ctx(), 'src')
    const nm = join(profiles(), 'src', 'node_modules')
    mkdirSync(join(nm, 'x'), { recursive: true })
    writeFileSync(join(nm, 'x', 'f'), '')
    cloneProfile(ctx(), 'src', 'dst')
    expect(existsSync(join(profiles(), 'dst', 'package.json'))).toBe(true)
    expect(existsSync(join(profiles(), 'dst', 'node_modules'))).toBe(false)
  })

  it('rejects missing source and invalid target', () => {
    expect(() => cloneProfile(ctx(), 'ghost', 'dst')).toThrow(/not found/)
    expect(() => cloneProfile(ctx(), 'src', 'Bad')).toThrow(/kebab-case/)
  })
})

describe('softDeleteProfile', () => {
  it('moves the profile into .trash', () => {
    createProfile(ctx(), 'gone')
    softDeleteProfile(ctx(), 'gone')
    expect(existsSync(join(profiles(), 'gone'))).toBe(false)
    expect(existsSync(join(profiles(), '.trash', 'gone'))).toBe(true)
  })

  it('auto-numbers a colliding trash name', () => {
    createProfile(ctx(), 'dup')
    softDeleteProfile(ctx(), 'dup')
    createProfile(ctx(), 'dup')
    softDeleteProfile(ctx(), 'dup')
    expect(existsSync(join(profiles(), '.trash', 'dup (2)'))).toBe(true)
  })
})

describe('removeBundle / reorderBundle', () => {
  it('removeBundle drops the layer and prunes with pnpm install', async () => {
    createProfile(ctx(), 'p')
    const mp = join(profiles(), 'p', 'package.json')
    writeFileSync(mp, JSON.stringify({ dsh: { profile: { bundles: ['a', 'b'] } }, dependencies: { a: 'link:/x' } }))
    await removeBundle(ctx(), 'p', 'a')
    const m = JSON.parse(readFileSync(mp, 'utf8'))
    expect(m.dsh.profile.bundles).toEqual(['b'])
    expect(m.dependencies).toEqual({})
    expect(runPnpm).toHaveBeenCalledWith(join(profiles(), 'p'), ['install', '--config.confirmModulesPurge=false'])
  })

  it('removeBundle throws when the bundle is absent', async () => {
    createProfile(ctx(), 'p')
    await expect(removeBundle(ctx(), 'p', 'nope')).rejects.toThrow(/没有 bundle/)
  })

  it('reorderBundle moves and clamps the index', () => {
    createProfile(ctx(), 'p')
    const mp = join(profiles(), 'p', 'package.json')
    writeFileSync(mp, JSON.stringify({ dsh: { profile: { bundles: ['a', 'b', 'c'] } } }))
    reorderBundle(ctx(), 'p', 'a', 2)
    expect(JSON.parse(readFileSync(mp, 'utf8')).dsh.profile.bundles).toEqual(['b', 'c', 'a'])
    reorderBundle(ctx(), 'p', 'c', 99)
    expect(JSON.parse(readFileSync(mp, 'utf8')).dsh.profile.bundles).toEqual(['b', 'a', 'c'])
  })
})

describe('listProfileSummaries', () => {
  it('summarizes each profile with its bundle / plugin / patch counts', () => {
    createProfile(ctx(), 'sum')
    const list = listProfileSummaries(ctx())
    expect(list).toEqual([{ name: 'sum', bundles: 1, plugins: 0, patchRows: 0 }])
  })
})

describe('profile files (source mode)', () => {
  it('reads a missing file as empty and round-trips a valid manifest', () => {
    expect(readProfileFile(ctx(), 'p', 'manifest').text).toBe('')
    mkdirSync(join(profiles(), 'p'), { recursive: true })
    const manifest = JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } },
      dependencies: { a: '^1' },
    })
    writeProfileFile(ctx(), 'p', 'manifest', manifest)
    expect(readProfileFile(ctx(), 'p', 'manifest').text).toBe(manifest)
  })

  it('rejects a malformed manifest', () => {
    mkdirSync(join(profiles(), 'p'), { recursive: true })
    expect(() => writeProfileFile(ctx(), 'p', 'manifest', '{')).toThrow(/JSON/)
    expect(() => writeProfileFile(ctx(), 'p', 'manifest', JSON.stringify({ dsh: { profile: { bundles: 'x' } } }))).toThrow(/bundles/)
    expect(() => writeProfileFile(ctx(), 'p', 'manifest', JSON.stringify({ dsh: { profile: { patchReload: 'nope' } } }))).toThrow(/patchReload/)
    expect(() => writeProfileFile(ctx(), 'p', 'manifest', JSON.stringify({ dependencies: { a: 1 } }))).toThrow(/dependencies/)
  })

  it('round-trips a valid patch and rejects a non-array one', () => {
    mkdirSync(join(profiles(), 'p'), { recursive: true })
    writeProfileFile(ctx(), 'p', 'patch', '- id: a\n')
    expect(readProfileFile(ctx(), 'p', 'patch').text).toBe('- id: a\n')
    expect(() => writeProfileFile(ctx(), 'p', 'patch', 'id: a\n')).toThrow(/顶层/)
  })
})

describe('dependencies / manifest meta', () => {
  it('sets and removes a dependency, pruning with pnpm install', async () => {
    createProfile(ctx(), 'p')
    await setDependency(ctx(), 'p', 'left-pad', '^1.3.0')
    let manifest = JSON.parse(readFileSync(join(profiles(), 'p', 'package.json'), 'utf8'))
    expect(manifest.dependencies['left-pad']).toBe('^1.3.0')
    expect(runPnpm).toHaveBeenCalledWith(join(profiles(), 'p'), ['install', '--config.confirmModulesPurge=false'])

    await removeDependency(ctx(), 'p', 'left-pad')
    manifest = JSON.parse(readFileSync(join(profiles(), 'p', 'package.json'), 'utf8'))
    expect(manifest.dependencies['left-pad']).toBeUndefined()
  })

  it('rejects a bad package name or an empty spec', async () => {
    createProfile(ctx(), 'p')
    await expect(setDependency(ctx(), 'p', 'bad name', '^1')).rejects.toThrow(/包名/)
    await expect(setDependency(ctx(), 'p', 'ok', '  ')).rejects.toThrow(/来源/)
  })

  it('updates display name and patchReload', () => {
    createProfile(ctx(), 'p')
    setManifestMeta(ctx(), 'p', { displayName: 'My Profile', patchReload: 'startup' })
    const manifest = JSON.parse(readFileSync(join(profiles(), 'p', 'package.json'), 'utf8'))
    expect(manifest.name).toBe('My Profile')
    expect(manifest.dsh.profile.patchReload).toBe('startup')
  })
})

describe('addBundle', () => {
  it('activates an installed package that declares a bundle patch', () => {
    createProfile(ctx(), 'p')
    const dir = join(profiles(), 'p', 'node_modules', 'my-bundle')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(dir, 'cordis.patch.yml'), '- id: a\n')
    addBundle(ctx(), 'p', 'my-bundle')
    const manifest = JSON.parse(readFileSync(join(profiles(), 'p', 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toContain('my-bundle')
  })

  it('refuses a package with no resolvable patch', () => {
    createProfile(ctx(), 'p')
    expect(() => addBundle(ctx(), 'p', 'ghost')).toThrow(/找不到/)
  })
})

describe('renameProfile', () => {
  it('renames the directory and keeps the conventional manifest name', () => {
    createProfile(ctx(), 'old')
    renameProfile(ctx(), 'old', 'new')
    expect(existsSync(join(profiles(), 'old'))).toBe(false)
    const manifest = JSON.parse(readFileSync(join(profiles(), 'new', 'package.json'), 'utf8'))
    expect(manifest.name).toBe('dsh-profile-new')
  })

  it('refuses a reserved name or a collision', () => {
    createProfile(ctx(), 'old')
    createProfile(ctx(), 'taken')
    expect(() => renameProfile(ctx(), 'old', 'web')).toThrow(/reserved/)
    expect(() => renameProfile(ctx(), 'old', 'taken')).toThrow(/already exists/)
  })
})

describe('exportProfile', () => {
  it('classifies bundles by source and strips link/file deps', () => {
    createProfile(ctx(), 'exp')
    writeFileSync(join(profiles(), 'exp', 'package.json'), JSON.stringify({
      name: 'dsh-profile-exp',
      dependencies: { npmA: '^1.0.0', locA: 'link:/x', plain: '^2.0.0' },
      dsh: { profile: { bundles: ['tpl', 'npmA', 'locA'], patchReload: 'startup' } },
    }))
    // locA is a real local plugin iff the store records a file:/link: dep for it.
    writeFileSync(join(store(), 'package.json'), JSON.stringify({ dependencies: { locA: 'link:/x' } }))
    const out = JSON.parse(exportProfile(ctx(), 'exp'))
    expect(out.schemaVersion).toBe(2)
    expect(out.bundles).toEqual([
      { name: 'tpl', source: 'dsh' },
      { name: 'npmA', source: 'npm', spec: '^1.0.0' },
      { name: 'locA', source: 'local' },
    ])
    // only non-bundle npm deps survive
    expect(out.dependencies).toEqual({ plain: '^2.0.0' })
    expect(out.dshVersion).toBe('1.0.0')
    expect(out.patchReload).toBe('startup')
  })
})

describe('listLocalBundles', () => {
  it('returns locally-linked bundles whose store dir exists', () => {
    createProfile(ctx(), 'p')
    writeFileSync(join(profiles(), 'p', 'package.json'), JSON.stringify({
      dependencies: { locA: 'link:/x', npmA: '^1.0.0' },
      dsh: { profile: { bundles: ['locA', 'npmA'] } },
    }))
    writeFileSync(join(store(), 'package.json'), JSON.stringify({ dependencies: { locA: 'link:/x' } }))
    const locDir = join(store(), 'node_modules', 'locA')
    mkdirSync(locDir, { recursive: true })
    writeFileSync(join(locDir, 'package.json'), '{}')
    const r = listLocalBundles(ctx(), 'p', store())
    expect(r).toEqual([{ name: 'locA', dir: locDir }])
  })
})

describe('importProfile', () => {
  it('rejects non-object / invalid input and a fresh-name clash', async () => {
    await expect(importProfile(ctx(), 'null')).rejects.toThrow(/不是对象/)
    await expect(importProfile(ctx(), '["x"]')).rejects.toThrow(/不是对象/)
    createProfile(ctx(), 'taken')
    const good = JSON.stringify({ name: 'taken', bundles: [], dependencies: {}, userPatch: '' })
    await expect(importProfile(ctx(), good)).rejects.toThrow(/already exists/)
  })

  it('refuses on a dsh major mismatch unless forced', async () => {
    const payload = JSON.stringify({ name: 'nou', dshVersion: '9.0.0', bundles: [], dependencies: {} })
    const r = await importProfile(ctx(), payload, { name: 'nou' })
    expect(r.ok).toBe(false)
    expect('dshMismatch' in r && r.dshMismatch === true).toBe(true)
  })

  it('imports in-box dsh bundles without any store install', async () => {
    const payload = JSON.stringify({
      dshVersion: '1.0.0', bundles: [{ name: 'tpl', source: 'dsh' }], dependencies: {}, userPatch: '',
    })
    const r = await importProfile(ctx(), payload, { name: 'baseonly' })
    expect(r.ok).toBe(true)
    expect('installed' in r && r.installed).toEqual([])
    expect(runPnpm).toHaveBeenCalledWith(join(profiles(), 'baseonly'), ['install', '--config.confirmModulesPurge=false'])
    // No patchReload in the payload → the host's custom-profile default.
    const m = JSON.parse(readFileSync(join(profiles(), 'baseonly', 'package.json'), 'utf8'))
    expect(m.dsh.profile.patchReload).toBe('live')
  })

  it('carries a payload patchReload into the manifest', async () => {
    const payload = JSON.stringify({
      dshVersion: '1.0.0', bundles: [], dependencies: {}, userPatch: '', patchReload: 'startup',
    })
    await importProfile(ctx(), payload, { name: 'frozen' })
    const m = JSON.parse(readFileSync(join(profiles(), 'frozen', 'package.json'), 'utf8'))
    expect(m.dsh.profile.patchReload).toBe('startup')
  })

  it('refuses a host-reserved target name', async () => {
    const payload = JSON.stringify({ dshVersion: '1.0.0', bundles: [], dependencies: {} })
    await expect(importProfile(ctx(), payload, { name: 'web' })).rejects.toThrow(/reserved/)
  })

  it('reuses an existing store version when it satisfies the range', async () => {
    const pkgDir = join(store(), 'archive', 'npmA', '1.2.0', 'node_modules', 'npmA')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ version: '1.2.0' }))
    const payload = JSON.stringify({
      dshVersion: '1.0.0', bundles: [{ name: 'npmA', source: 'npm', spec: '^1.0.0' }], dependencies: {},
    })
    const r = await importProfile(ctx(), payload, { name: 'reuse' })
    expect(addPlugin).not.toHaveBeenCalled()
    expect(installIntoProfile).toHaveBeenCalledWith(profiles(), 'reuse', 'npmA', store())
    expect('installed' in r && r.installed).toEqual(['npmA'])
  })

  it('downloads from npm when no store version is usable', async () => {
    const payload = JSON.stringify({
      dshVersion: '1.0.0', bundles: [{ name: 'fresh', source: 'npm', spec: '^3.0.0' }], dependencies: {},
    })
    const r = await importProfile(ctx(), payload, { name: 'dl' })
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
    const r = await importProfile(ctx(), payload, { name: 'offline', localSource: join(root, 'bundle-src') })
    expect(addLocalPlugin).toHaveBeenCalled()
    expect('ok' in r && r.ok).toBe(true)
  })

  it('reports a bundle as missing when the store install fails', async () => {
    vi.mocked(addPlugin).mockResolvedValueOnce({ ok: false, text: 'registry down' })
    const payload = JSON.stringify({
      dshVersion: '1.0.0', bundles: [{ name: 'flake', source: 'npm', spec: '^1.0.0' }], dependencies: {},
    })
    const r = await importProfile(ctx(), payload, { name: 'flakey' })
    expect(r).toMatchObject({ ok: true, installed: [], missing: ['flake'] })
  })
})
