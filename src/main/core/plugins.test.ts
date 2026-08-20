/**
 * Plugin store operations: store initialisation, listing, local/zip installs,
 * profile scopes, installed-dir resolution, the installed overview and
 * profile install-into. `runPnpm` is mocked so network/FS side effects stay out.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  installIntoProfile, installedStoreVersion, listPlugins, listProfileScopes,
  readPluginReadme, removePlugin,
} from './plugins.ts'
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

  it('installedStoreVersion reads the installed package version', () => {
    expect(installedStoreVersion('', 'x')).toBeUndefined()
    mkPkg(join(store(), 'node_modules', 'pkg-a'), '3.0.0')
    expect(installedStoreVersion(store(), 'pkg-a')).toBe('3.0.0')
  })

  it('addPlugin/removePlugin hand the source to pnpm', async () => {
    await addPlugin(store(), 'foo@^1')
    expect(runPnpm).toHaveBeenCalledWith(store(), ['add', 'foo@^1', '--fetch-retries=3', '--fetch-retry-maxtimeout=60000'])
    await removePlugin(store(), 'foo')
    expect(runPnpm).toHaveBeenCalledWith(store(), ['remove', 'foo'])
  })

  it('addPlugin/removePlugin reject when no store is configured', async () => {
    const r = await addPlugin('', 'x')
    expect(r.ok).toBe(false)
    expect((await removePlugin('', 'x')).ok).toBe(false)
  })
})

describe('local installs', () => {
  it('adds a plugin from a directory source', async () => {
    const src = join(root, 'src-plugin')
    mkPkg(src, '1.0.0')
    const r = await addLocalPlugin(store(), src)
    expect(r.ok).toBe(true)
    expect(runPnpm).toHaveBeenCalledWith(store(), ['add', `file:${src}`])
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
    await addLocalPlugin(store(), zipPath)
    expect(runPnpm).toHaveBeenCalled()
    const fileArg = vi.mocked(runPnpm).mock.calls.at(-1)?.[1][1] as string
    expect(fileArg.startsWith('file:')).toBe(true)
    expect(fileArg).toContain('.import')
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

  it('findInstalledDir checks the store first, then profiles', () => {
    mkPkg(join(store(), 'node_modules', 'lift'), '1.0.0')
    expect(findInstalledDir([], store(), 'lift')).toBe(join(store(), 'node_modules', 'lift'))
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
    expect(tpl.usage).toEqual([{ dsh: 'dsh@d', dshVersion: 'd', profile: 'p1' }])

    const bundleA = rows.find(r => r.name === 'bundleA')!
    expect(bundleA.inStore).toBe(true)
    expect(bundleA.builtin).toBe(false)

    // store-only download, no usage → still listed, not builtin
    const only = rows.find(r => r.name === 'storeOnly')!
    expect(only.inStore).toBe(true)
    expect(only.builtin).toBe(false)
    expect(only.usage).toEqual([])

    expect(names.sort()).toEqual(['bundleA', 'fileA', 'storeOnly', 'tpl'])
  })

  it('skips a profile with an unreadable manifest', () => {
    const homeD = join(root, 'home-d2')
    const base = join(homeD, 'profiles')
    mkdirSync(join(base, 'broken'), { recursive: true })
    writeFileSync(join(base, 'broken', 'package.json'), '{ not json')
    expect(buildInstalledOverview([scope('d', homeD)], store())).toEqual([])
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
    mkProfile(base, 'prof', {})
    vi.mocked(runPnpm).mockResolvedValueOnce({ ok: false, text: 'boom' })
    const r = await installIntoProfile('prof', 'pkg-a', store(), base)
    expect(r.ok).toBe(false)
    expect(r.text).toContain('pnpm install 失败')
    const m = JSON.parse(readFileSync(join(base, 'prof', 'package.json'), 'utf8'))
    expect(m.dependencies['pkg-a']).toBe(`link:${join(store(), 'node_modules', 'pkg-a')}`)
  })

  it('reports link-only install when the store package stays absent', async () => {
    const base = join(root, 'profs-2')
    mkProfile(base, 'prof', {})
    const r = await installIntoProfile('prof', 'orphan', store(), base)
    expect(r.ok).toBe(true)
    expect(r.activated).toBe(false)
    expect(r.text).toContain('link 依赖安装')
  })

  it('activates a declaring bundle by appending it to the layer', async () => {
    const base = join(root, 'profs-3')
    mkProfile(base, 'prof', { dsh: { profile: { bundles: [] } } })
    mkPkg(join(store(), 'node_modules', 'pkg-b'), '1.0.0', { dsh: { bundle: { patch: 'x' } } })
    const r = await installIntoProfile('prof', 'pkg-b', store(), base)
    expect(r.ok).toBe(true)
    expect(r.activated).toBe(true)
    const m = JSON.parse(readFileSync(join(base, 'prof', 'package.json'), 'utf8'))
    expect(m.dsh.profile.bundles).toEqual(['pkg-b'])
  })

  it('says already-in-layer when the bundle is present', async () => {
    const base = join(root, 'profs-4')
    mkProfile(base, 'prof', { dsh: { profile: { bundles: ['pkg-c'] } } })
    mkPkg(join(store(), 'node_modules', 'pkg-c'), '1.0.0', { dsh: { bundle: { patch: 'x' } } })
    const r = await installIntoProfile('prof', 'pkg-c', store(), base)
    expect(r.text).toContain('已在 bundle 层')
    expect(r.activated).toBe(true)
  })
})

function mkDirEmpty(dir: string): void { mkdirSync(dir, { recursive: true }) }