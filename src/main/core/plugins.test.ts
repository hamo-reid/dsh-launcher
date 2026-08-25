/**
 * Plugin store operations: store initialisation, listing, local/zip installs,
 * profile scopes, installed-dir resolution, the installed overview and
 * profile install-into. `runPnpm` is mocked so network/FS side effects stay out.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

/* pnpm interactions are stubbed; FS helpers run against a disposable tree. */
vi.mock('./pnpm.ts', async (importActual) => {
  const actual = await importActual<typeof import('./pnpm.ts')>()
  return { ...actual, runPnpm: vi.fn() }
})
import { runPnpm } from './pnpm.ts'
import {
  addLocalPlugin, addPlugin, buildInstalledOverview, findInstalledDir, initStore,
  installIntoProfile, installSource, installedStoreVersion, listPlugins, listProfileScopes,
  migrateStore, needsStoreMigration, readPluginReadme, removePlugin,
  removePluginFromProfiles, storeVersions,
} from './plugins.ts'
import * as appStateModule from './appState.ts'
import type { DshScope } from './appState.ts'

let root: string
const store = (): string => join(root, 'store')
const scope = (id: string, home: string, profilesDir?: string): DshScope =>
  ({ id, name: `dsh@${id}`, home, ...(profilesDir !== undefined ? { profilesDir } : {}) })

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-plugins-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(store(), { recursive: true })
  vi.mocked(runPnpm).mockReset()
  vi.mocked(runPnpm).mockResolvedValue({ ok: true, text: 'added 1 package' })
})

function mkPkg(dir: string, version = '1.0.0', extra: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: dir.split(/[\\/]/).pop(), version, ...extra }))
}

function mkProfile(rootDir: string, profile: string, manifest: Record<string, unknown>): void {
  const p = join(rootDir, profile)
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'package.json'), JSON.stringify(manifest))
}

/** Seed an archived store version at archive/<pkg>/<version>/node_modules/<pkg>. */
function seedVersion(pkg: string, version: string, extra: Record<string, unknown> = {}): void {
  mkPkg(join(store(), 'archive', pkg, version, 'node_modules', pkg), version, extra)
}

/** Mock `pnpm add`: materialise `node_modules/<name>` for the source. Reads the
 * real name/version from `file:` sources (the legacy→archive migration reinstalls
 * every package that way); non-`file:` sources fall back to `fresh`. */
function mockSourceInstall(): void {
  vi.mocked(runPnpm).mockImplementation(async (dir, args) => {
    const source = args[1] ?? ''
    let name = 'fresh'
    let version = '0.9.0'
    const srcPath = source.startsWith('file:') ? source.slice(5) : ''
    if (srcPath !== '' && existsSync(join(srcPath, 'package.json'))) {
      const pkg = JSON.parse(readFileSync(join(srcPath, 'package.json'), 'utf8')) as { name?: string; version?: string }
      name = pkg.name ?? name
      version = pkg.version ?? version
    }
    mkPkg(join(dir, 'node_modules', name), version)
    return { ok: true, text: 'added' }
  })
}

describe('store basics', () => {
  it('initStore writes an empty private manifest', () => {
    const d = join(store(), 'init')
    initStore(d)
    const m = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))
    expect(m).toEqual({ name: 'plugin-store', private: true, dependencies: {} })
  })

  it('listPlugins maps manifest deps; empty dir → []', () => {
    expect(listPlugins('')).toEqual([])
    writeFileSync(join(store(), 'package.json'), JSON.stringify({ dependencies: { a: '^1', b: '^2' } }))
    expect(listPlugins(store())).toEqual([{ name: 'a', version: '^1' }, { name: 'b', version: '^2' }])
    expect(listPlugins(join(root, 'no-store'))).toEqual([])
  })

  it('installedStoreVersion reports the highest archived version', () => {
    expect(installedStoreVersion('', 'x')).toBeUndefined()
    seedVersion('pkg-a', '1.0.0')
    seedVersion('pkg-a', '3.0.0')
    expect(installedStoreVersion(store(), 'pkg-a')).toBe('3.0.0')
    expect(installedStoreVersion(store(), 'ghost')).toBeUndefined()
  })

  it('addPlugin archives into archive/ and removePlugin uninstalls', async () => {
    // simulate pnpm resolving the install into the plugin's staging project
    vi.mocked(runPnpm).mockImplementation(async (dir) => {
      mkPkg(join(dir, 'node_modules', 'foo'), '1.2.3')
      return { ok: true, text: 'added' }
    })
    await addPlugin(store(), 'foo@^1')
    const staging = join(store(), 'archive', 'foo', '.staging')
    expect(runPnpm).toHaveBeenCalledWith(staging, ['add', 'foo@^1', '--fetch-retries=3', '--fetch-retry-maxtimeout=60000'], undefined)
    expect(listPlugins(store())).toContainEqual({ name: 'foo', version: '1.2.3' })
    await removePlugin(store(), 'foo')
    expect(existsSync(join(store(), 'archive', 'foo'))).toBe(false)
  })

  it('removePlugin drops a single archived version and keeps the others', async () => {
    seedVersion('dup', '1.0.0')
    seedVersion('dup', '2.0.0')
    removePlugin(store(), 'dup', '1.0.0')
    expect(listPlugins(store())).toEqual([{ name: 'dup', version: '2.0.0' }])
  })

  it('addPlugin/removePlugin reject when no store is configured', async () => {
    const r = await addPlugin('', 'x')
    expect(r.ok).toBe(false)
    expect((await removePlugin('', 'x')).ok).toBe(false)
  })
})

describe('local installs', () => {
  it('adds a plugin from a directory source into the versioned store', async () => {
    const src = join(root, 'src-plugin')
    mkPkg(src, '1.0.0')
    vi.mocked(runPnpm).mockImplementation(async (dir) => {
      mkPkg(join(dir, 'node_modules', 'src-plugin'), '1.0.0')
      return { ok: true, text: 'added' }
    })
    const r = await addLocalPlugin(store(), src)
    expect(r.ok).toBe(true)
    const staging = join(store(), 'archive', 'src-plugin', '.staging')
    expect(runPnpm).toHaveBeenCalledWith(staging, ['add', `file:${src}`, '--fetch-retries=3', '--fetch-retry-maxtimeout=60000'], undefined)
    expect(listPlugins(store())).toContainEqual({ name: 'src-plugin', version: '1.0.0' })
  })

  it('rejects a missing path and a non-zip file', async () => {
    expect((await addLocalPlugin(store(), join(root, 'nope'))).ok).toBe(false)
    const txt = join(root, 'pkg.txt')
    writeFileSync(txt, 'x')
    expect((await addLocalPlugin(store(), txt)).ok).toBe(false)
  })

  it('extracts a zip and installs its package root', async () => {
    const zipPath = join(root, 'bundle.zip')
    const zip = new AdmZip()
    zip.addFile('inner/package.json', Buffer.from(JSON.stringify({ name: 'inner', version: '1.0.0' })))
    zip.writeZip(zipPath)
    vi.mocked(runPnpm).mockImplementation(async (dir) => {
      mkPkg(join(dir, 'node_modules', 'inner'), '1.0.0')
      return { ok: true, text: 'added' }
    })
    await addLocalPlugin(store(), zipPath)
    // installSource now also runs a re-link `pnpm install` after archiving, so find
    // the `add` call specifically rather than assuming it is the last one.
    const addCall = vi.mocked(runPnpm).mock.calls.find(([, args]) => args[0] === 'add')
    expect(addCall).toBeDefined()
    const fileArg = addCall![1][1] as string
    expect(fileArg.startsWith('file:')).toBe(true)
    expect(fileArg).toContain('.import')
    expect(listPlugins(store())).toContainEqual({ name: 'inner', version: '1.0.0' })
  })

  it('reports a broken zip', async () => {
    const bad = join(root, 'bad.zip')
    writeFileSync(bad, 'not a zip')
    expect((await addLocalPlugin(store(), bad)).ok).toBe(false)
  })

  it('reports a zip without a package.json', async () => {
    const z = join(root, 'nopkg.zip')
    const zip = new AdmZip(); zip.addFile('folder/readme.txt', Buffer.from('hi')); zip.writeZip(z)
    expect((await addLocalPlugin(store(), z)).ok).toBe(false)
  })
})

describe('scopes and installed-dir resolution', () => {
  it('listProfileScopes lists profiles owning a manifest, sorted', () => {
    const homeD = join(root, 'home-a')
    const base = join(homeD, 'profiles')
    mkProfile(base, 'zeta', {})
    mkProfile(base, 'alpha', {})
    mkDirEmpty(join(base, 'hidden'))
    const r = listProfileScopes([scope('a', homeD)])
    expect(r).toEqual([{ id: 'a', name: 'dsh@a', version: undefined, profiles: ['alpha', 'zeta'] }])
  })

  it('findInstalledDir checks the store versions first, then profiles', () => {
    seedVersion('lift', '1.0.0')
    expect(findInstalledDir([], store(), 'lift')).toBe(join(store(), 'archive', 'lift', '1.0.0', 'node_modules', 'lift'))
    const homeD = join(root, 'home-b')
    mkDirEmpty(homeD)
    mkPkg(join(homeD, 'profiles', 'prof-p', 'node_modules', 'ember'), '2.0.0')
    expect(findInstalledDir([scope('b', homeD)], store(), 'ember')).toContain('prof-p')
    expect(findInstalledDir([scope('b', homeD)], store(), 'ghost')).toBeUndefined()
  })

  it('readPluginReadme finds a README case-insensitively', () => {
    const homeD = join(root, 'home-c')
    const pkgDir = join(homeD, 'profiles', 'prof-p', 'node_modules', 'wik')
    mkPkg(pkgDir, '1.0.0')
    writeFileSync(join(pkgDir, 'README.md'), '# hi')
    expect(readPluginReadme([scope('c', homeD)], store(), 'wik')).toBe('# hi')
  })

  it('readPluginReadme returns "" when the plugin is not installed', () => {
    const homeD = join(root, 'home-c2')
    mkDirEmpty(join(homeD, 'profiles'))
    expect(readPluginReadme([scope('c', homeD)], store(), 'ghost')).toBe('')
  })
})

describe('buildInstalledOverview', () => {
  it('unions profile usage and store downloads, flagging builtins', () => {
    const homeD = join(root, 'home-d')
    const base = join(homeD, 'profiles')
    const myStore = join(store(), 'out')
    mkdirSync(myStore, { recursive: true })
    writeFileSync(join(myStore, 'package.json'), JSON.stringify({ dependencies: { 'storeOnly': '^1', 'bundleA': '^1' } }))
    mkPkg(join(myStore, 'node_modules', 'storeOnly'), '1.0.0')
    mkPkg(join(myStore, 'node_modules', 'bundleA'), '2.0.0')

    mkProfile(base, 'p1', {
      dependencies: { 'bundleA': '^1', 'fileA': 'link:/x' },
      dsh: { profile: { bundles: ['tpl', 'bundleA'] } },
    })
    mkPkg(join(base, 'p1', 'node_modules', 'fileA'), '0.1.0')
    mkPkg(join(base, 'p1', 'node_modules', 'tpl'), '9.9.9')

    const rows = buildInstalledOverview([{ id: 'd', name: 'dsh@d', version: 'd', home: homeD }], myStore)
    const names = rows.map(r => r.name)

    // template bundle in use but not in store → builtin
    const tpl = rows.find(r => r.name === 'tpl')!
    expect(tpl.builtin).toBe(true)
    expect(tpl.usage).toEqual([{ dsh: 'dsh@d', dshVersion: 'd', profile: 'p1', version: '9.9.9' }])
    // built-in template (in use, not in store) → sourced from the dsh harness.
    expect(tpl.sources).toEqual(['dsh'])

    const bundleA = rows.find(r => r.name === 'bundleA')!
    expect(bundleA.inStore).toBe(true)
    expect(bundleA.builtin).toBe(false)
    // bundleA is a bundle layer of p1 but is NOT resolved into p1's node_modules
    // here → its usage version stays undefined (signals "not applied yet").
    expect(bundleA.usage).toEqual([{ dsh: 'dsh@d', dshVersion: 'd', profile: 'p1', version: undefined }])
    // no origin record → falls back to a generic "store" source.
    expect(bundleA.sources).toEqual(['store'])

    // store-only download, no usage → still listed, not builtin
    const only = rows.find(r => r.name === 'storeOnly')!
    expect(only.inStore).toBe(true)
    expect(only.builtin).toBe(false)
    expect(only.usage).toEqual([])
    expect(only.sources).toEqual(['store'])

    expect(names.sort()).toEqual(['bundleA', 'fileA', 'storeOnly', 'tpl'])
  })

  it('labels archived versions by their recorded source (github/npm/local/store)', () => {
    seedVersion('gh', '1.0.0')
    seedVersion('npmPkg', '2.0.0')
    seedVersion('loc', '3.0.0')
    seedVersion('old', '4.0.0') // no sidecar record → store
    writeFileSync(join(store(), '.pm-sources.json'), JSON.stringify({
      'gh@1.0.0': 'github', 'npmPkg@2.0.0': 'npm', 'loc@3.0.0': 'local',
    }))

    const rows = buildInstalledOverview([], store())
    const byName = (n: string): { sources: string[] } => rows.find(r => r.name === n)!
    expect(byName('gh').sources).toEqual(['github'])
    expect(byName('npmPkg').sources).toEqual(['npm'])
    expect(byName('loc').sources).toEqual(['local'])
    expect(byName('old').sources).toEqual(['store'])
  })

  it('skips a profile with an unreadable manifest', () => {
    const homeD = join(root, 'home-d2')
    const base = join(homeD, 'profiles')
    mkdirSync(join(base, 'broken'), { recursive: true })
    writeFileSync(join(base, 'broken', 'package.json'), '{ not json')
    expect(buildInstalledOverview([scope('d', homeD)], store())).toEqual([])
  })
})

describe('removePluginFromProfiles', () => {
  it('detaches a linked plugin from every using profile (link dep + bundle layer)', async () => {
    const homeD = join(root, 'home-cascade')
    const base = join(homeD, 'profiles')
    mkProfile(base, 'p1', {
      dependencies: { '@scope/plug': 'link:C:/store/archive/@scope/plug/1.0.0/node_modules/@scope/plug' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@scope/plug'] } },
    })
    mkProfile(base, 'p2', { dependencies: { '@scope/plug': 'link:C:/store/archive/@scope/plug/1.0.0/node_modules/@scope/plug', other: '^1' } })
    mkProfile(base, 'p3', { dependencies: { unrelated: '^1' } })
    // Simulate the installed node_modules copies the overview would otherwise scan.
    mkPkg(join(base, 'p1', 'node_modules', '@scope', 'plug'), '1.0.0')
    mkPkg(join(base, 'p2', 'node_modules', '@scope', 'plug'), '1.0.0')

    const affected = await removePluginFromProfiles([scope('c', homeD)], '@scope/plug')

    expect(affected).toHaveLength(2)
    // the plugin's folder is PHYSICALLY removed from both profiles.
    expect(existsSync(join(base, 'p1', 'node_modules', '@scope', 'plug'))).toBe(false)
    expect(existsSync(join(base, 'p2', 'node_modules', '@scope', 'plug'))).toBe(false)
    const p1 = JSON.parse(readFileSync(join(base, 'p1', 'package.json'), 'utf8'))
    expect(p1.dependencies?.['@scope/plug']).toBeUndefined()
    expect(p1.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
    const p2 = JSON.parse(readFileSync(join(base, 'p2', 'package.json'), 'utf8'))
    expect(p2.dependencies?.['@scope/plug']).toBeUndefined()
    expect(p2.dependencies?.other).toBe('^1')
    // untouched profile keeps its own deps
    const p3 = JSON.parse(readFileSync(join(base, 'p3', 'package.json'), 'utf8'))
    expect(p3.dependencies?.unrelated).toBe('^1')
    expect(runPnpm).toHaveBeenCalledTimes(2)
  })

  it('leaves a profile whose spec is an npm range untouched', async () => {
    const homeD = join(root, 'home-cascade2')
    const base = join(homeD, 'profiles')
    mkProfile(base, 'p1', { dependencies: { plug: '^1.0.0' } })

    const affected = await removePluginFromProfiles([scope('c', homeD)], 'plug')

    expect(affected).toHaveLength(0)
    const p1 = JSON.parse(readFileSync(join(base, 'p1', 'package.json'), 'utf8'))
    expect(p1.dependencies?.plug).toBe('^1.0.0')
    expect(runPnpm).not.toHaveBeenCalled()
  })
})

describe('installSource (cancellation)', () => {
  it('cleans its staging dir and surfaces aborted when cancelled', async () => {
    const name = 'abortedPkg'
    vi.mocked(runPnpm).mockResolvedValueOnce({ ok: false, aborted: true, text: 'cancelled' })
    const staging = join(join(store(), 'archive'), name, '.staging')
    const res = await installSource(store(), name, `${name}@1.0.0`, new AbortController().signal)
    expect(res.ok).toBe(false)
    expect(res.aborted).toBe(true)
    // the half-downloaded pnpm project is gone
    expect(existsSync(staging)).toBe(false)
  })
})

describe('installIntoProfile', () => {
  it('rejects without a store or a missing profile', async () => {
    const r1 = await installIntoProfile('prof', 'pkg', '')
    expect(r1.ok).toBe(false)
    const r2 = await installIntoProfile('missing', 'pkg', store(), join(root, 'profs'))
    expect(r2.ok).toBe(false)
  })

  it('adds a link dependency and reports a failed pnpm install', async () => {
    const base = join(root, 'profs-1')
    seedVersion('pkg-a', '1.0.0')
    mkProfile(base, 'prof', {})
    vi.mocked(runPnpm).mockResolvedValueOnce({ ok: false, text: 'boom' })
    const r = await installIntoProfile('prof', 'pkg-a', store(), base)
    expect(r.ok).toBe(false)
    expect(r.text).toContain('pnpm install 失败')
    const m = JSON.parse(readFileSync(join(base, 'prof', 'package.json'), 'utf8'))
    expect(m.dependencies['pkg-a']).toBe(`link:${join(store(), 'archive', 'pkg-a', '1.0.0', 'node_modules', 'pkg-a')}`)
  })

  it('reports link-only install when the store package stays absent', async () => {
    const base = join(root, 'profs-2')
    seedVersion('orphan', '1.0.0')
    mkProfile(base, 'prof', {})
    const r = await installIntoProfile('prof', 'orphan', store(), base)
    expect(r.ok).toBe(true)
    expect(r.activated).toBe(false)
    expect(r.text).toContain('link 依赖安装')
  })

  it('activates a declaring bundle by appending it to the layer', async () => {
    const base = join(root, 'profs-3')
    mkProfile(base, 'prof', { dsh: { profile: { bundles: [] } } })
    seedVersion('pkg-b', '1.0.0', { dsh: { bundle: { patch: 'x' } } })
    const r = await installIntoProfile('prof', 'pkg-b', store(), base)
    expect(r.ok).toBe(true)
    expect(r.activated).toBe(true)
    const m = JSON.parse(readFileSync(join(base, 'prof', 'package.json'), 'utf8'))
    expect(m.dsh.profile.bundles).toEqual(['pkg-b'])
  })

  it('says already-in-layer when the bundle is present', async () => {
    const base = join(root, 'profs-4')
    mkProfile(base, 'prof', { dsh: { profile: { bundles: ['pkg-c'] } } })
    seedVersion('pkg-c', '1.0.0', { dsh: { bundle: { patch: 'x' } } })
    const r = await installIntoProfile('prof', 'pkg-c', store(), base)
    expect(r.text).toContain('已在 bundle 层')
    expect(r.activated).toBe(true)
  })
})

describe('legacy migration', () => {
  it('hoists a legacy top-level store into versions on the first write', async () => {
    // Legacy layout: flat manifest deps + packages in the top-level node_modules.
    writeFileSync(join(store(), 'package.json'), JSON.stringify({ name: 'plugin-store', private: true, dependencies: { oldy: '^1.0.0', range: '^2.0.0' } }))
    mkPkg(join(store(), 'node_modules', 'oldy'), '1.0.0')
    mkPkg(join(store(), 'node_modules', 'range'), '2.1.0')
    // A download triggers the migration.
    mockSourceInstall()
    await addPlugin(store(), 'fresh@^0')

    expect(listPlugins(store())).toContainEqual({ name: 'oldy', version: '1.0.0' })
    expect(listPlugins(store())).toContainEqual({ name: 'range', version: '2.1.0' })
    expect(listPlugins(store())).toContainEqual({ name: 'fresh', version: '0.9.0' })
    // The legacy manifest deps were cleared so nothing is listed twice.
    const m = JSON.parse(readFileSync(join(store(), 'package.json'), 'utf8'))
    expect(m.dependencies).toEqual({})
  })

  it('retargets a profile that links into a moved top-level package', async () => {
    writeFileSync(join(store(), 'package.json'), JSON.stringify({ name: 'plugin-store', private: true, dependencies: { app: '^1.0.0' } }))
    mkPkg(join(store(), 'node_modules', 'app'), '1.0.0')
    // A 0.1.4 profile pointing at the top-level store path via `link:`.
    const home = join(root, 'dshP')
    const profDir = join(home, 'profiles')
    mkProfile(profDir, 'prof', { dependencies: { app: `link:${join(store(), 'node_modules', 'app')}` } })

    const spy = vi.spyOn(appStateModule, 'dshScopes').mockReturnValue([{ id: 'p', name: 'dsh@p', home, profilesDir: profDir } as DshScope])
    try {
      mockSourceInstall()
      await addPlugin(store(), 'fresh@^0')
    } finally {
      spy.mockRestore()
    }
    const profileManifest = JSON.parse(readFileSync(join(profDir, 'prof', 'package.json'), 'utf8'))
    expect(profileManifest.dependencies.app).toBe(`link:${join(store(), 'archive', 'app', '1.0.0', 'node_modules', 'app')}`)
    expect(listPlugins(store())).toContainEqual({ name: 'app', version: '1.0.0' })
  })

  it('needsStoreMigration flags only unabsorbed flat packages', () => {
    expect(needsStoreMigration('')).toBe(false)
    expect(needsStoreMigration(join(root, 'no-store'))).toBe(false)
    // A store whose manifest has no deps → nothing to migrate.
    writeFileSync(join(store(), 'package.json'), JSON.stringify({ name: 'plugin-store', private: true, dependencies: {} }))
    expect(needsStoreMigration(store())).toBe(false)
    // A legacy flat package present in the top-level node_modules → migrate.
    writeFileSync(join(store(), 'package.json'), JSON.stringify({ name: 'plugin-store', private: true, dependencies: { legacy: '^1.0.0' } }))
    mkPkg(join(store(), 'node_modules', 'legacy'), '1.0.0')
    expect(needsStoreMigration(store())).toBe(true)
    // Once that same package is represented in versions, nothing pending.
    seedVersion('legacy', '1.0.0')
    expect(needsStoreMigration(store())).toBe(false)
  })

  it('migrateStore absorbs a legacy layout and is idempotent', async () => {
    writeFileSync(join(store(), 'package.json'), JSON.stringify({ name: 'plugin-store', private: true, dependencies: { old1: '^1.0.0', old2: '^2.0.0' } }))
    mkPkg(join(store(), 'node_modules', 'old1'), '1.0.0')
    mkPkg(join(store(), 'node_modules', 'old2'), '2.1.0')
    expect(needsStoreMigration(store())).toBe(true)

    mockSourceInstall()
    await migrateStore(store())

    expect(listPlugins(store())).toContainEqual({ name: 'old1', version: '1.0.0' })
    expect(listPlugins(store())).toContainEqual({ name: 'old2', version: '2.1.0' })
    expect(needsStoreMigration(store())).toBe(false)

    // Re-running is a no-op and leaves nothing left to migrate.
    const manifest = JSON.parse(readFileSync(join(store(), 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({})
    await migrateStore(store())
    expect(needsStoreMigration(store())).toBe(false)
    expect(listPlugins(store())).toHaveLength(2)
  })

  it('falls back to an online reinstall when the offline cache misses', async () => {
    writeFileSync(join(store(), 'package.json'), JSON.stringify({ name: 'plugin-store', private: true, dependencies: { occ: '^1.0.0' } }))
    mkPkg(join(store(), 'node_modules', 'occ'), '1.0.0')
    // First (offline) attempt misses the cache → non-zero + no package; the
    // online retry then materialises the archive package.
    vi.mocked(runPnpm).mockImplementation(async (dir, args) => {
      if (args.includes('--offline')) return { ok: false, text: 'ERR_PNPM_OFFLINE_MISSING' }
      mkPkg(join(dir, 'node_modules', 'occ'), '1.0.0')
      return { ok: true, text: 'added' }
    })
    await migrateStore(store())
    expect(listPlugins(store())).toContainEqual({ name: 'occ', version: '1.0.0' })
    expect(needsStoreMigration(store())).toBe(false)
  })
})

describe('scoped packages (real-name multi-level archive)', () => {
  it('listPlugins / storeVersions surface scoped packages by real name', () => {
    seedVersion('@acme/tool', '1.2.3')
    // archive/@acme/tool/1.2.3/node_modules/@acme/tool
    expect(storeVersions(store(), '@acme/tool')).toEqual(['1.2.3'])
    expect(listPlugins(store())).toContainEqual({ name: '@acme/tool', version: '1.2.3' })
    expect(existsSync(join(store(), 'archive', '@acme', 'tool', '1.2.3', 'node_modules', '@acme', 'tool', 'package.json'))).toBe(true)
  })

  it('addPlugin downloads a scoped package into the nested archive layout', async () => {
    vi.mocked(runPnpm).mockImplementation(async (dir) => {
      mkPkg(join(dir, 'node_modules', '@scope', 'name'), '2.0.0')
      return { ok: true, text: 'added' }
    })
    const r = await addPlugin(store(), '@scope/name@^2')
    expect(r.ok).toBe(true)
    expect(listPlugins(store())).toContainEqual({ name: '@scope/name', version: '2.0.0' })
    expect(existsSync(join(store(), 'archive', '@scope', 'name', '2.0.0', 'node_modules', '@scope', 'name', 'package.json'))).toBe(true)
  })

  it('keeps multiple scoped versions and separate scope siblings', async () => {
    seedVersion('@acme/tool', '1.0.0')
    seedVersion('@acme/tool', '1.1.0')
    seedVersion('@acme/other', '0.5.0')
    expect(listPlugins(store())).toContainEqual({ name: '@acme/tool', version: '1.0.0' })
    expect(listPlugins(store())).toContainEqual({ name: '@acme/tool', version: '1.1.0' })
    expect(listPlugins(store())).toContainEqual({ name: '@acme/other', version: '0.5.0' })
  })

  it('removing a single scoped version keeps siblings and the scope dir', async () => {
    seedVersion('@acme/tool', '1.0.0')
    seedVersion('@acme/tool', '1.1.0')
    const r = await removePlugin(store(), '@acme/tool', '1.0.0')
    expect(r.ok).toBe(true)
    expect(listPlugins(store())).toContainEqual({ name: '@acme/tool', version: '1.1.0' })
    expect(listPlugins(store())).not.toContainEqual({ name: '@acme/tool', version: '1.0.0' })
    expect(existsSync(join(store(), 'archive', '@acme', 'tool'))).toBe(true)
  })

  it('removing the last scoped version prunes the empty scope dir', async () => {
    seedVersion('@acme/tool', '1.0.0')
    await removePlugin(store(), '@acme/tool') // whole plugin
    expect(existsSync(join(store(), 'archive', '@acme', 'tool'))).toBe(false)
    expect(existsSync(join(store(), 'archive', '@acme'))).toBe(false) // empty @scope shell swept away
  })

  it('migrateStore absorbs a legacy scoped package under its real name', async () => {
    writeFileSync(join(store(), 'package.json'), JSON.stringify({ name: 'plugin-store', private: true, dependencies: { '@old/scope': '^1.0.0' } }))
    mkPkg(join(store(), 'node_modules', '@old', 'scope'), '1.0.0', { name: '@old/scope' })
    mockSourceInstall()
    await migrateStore(store())
    expect(listPlugins(store())).toContainEqual({ name: '@old/scope', version: '1.0.0' })
    expect(existsSync(join(store(), 'archive', '@old', 'scope', '1.0.0', 'node_modules', '@old', 'scope', 'package.json'))).toBe(true)
  })
})

function mkDirEmpty(dir: string): void { mkdirSync(dir, { recursive: true }) }