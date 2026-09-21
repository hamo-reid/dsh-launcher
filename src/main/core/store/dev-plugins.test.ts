/**
 * Dev plugins: the settings-backed registry (independent of the store),
 * patch-driven resolution diagnosis, and the reversible peer shim.
 * `installAnchor` is mocked so the shim can be exercised against a disposable
 * tree instead of a real dsh install.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../profile/home.ts', async (importActual) => {
  const actual = await importActual<typeof import('../profile/home.ts')>()
  return { ...actual, installAnchor: vi.fn() }
})

// pnpm is stubbed so the build path never spawns a real process.
vi.mock('../dsh/pnpm.ts', async (importActual) => {
  const actual = await importActual<typeof import('../dsh/pnpm.ts')>()
  return { ...actual, runPnpm: vi.fn() }
})

import { installAnchor } from '../profile/home.ts'
import { runPnpm } from '../dsh/pnpm.ts'
import { openDatabase, saveSettings } from '../settings/settings.ts'
import { contextForEntry } from '../profile/appState.ts'
import {
  buildDevPlugin, cachedDiagnosis, defaultDevBuild, devScriptOptions, diagnoseDevPlugin, findWorkspaceRoot, listDevPlugins,
  registerDevPlugin, removeDevPlugin, shimDevPeers, unshimDevPeers,
} from './dev.ts'

let root: string
const repo = (): string => join(root, 'repo')
const pkgDir = (): string => join(repo(), 'packages', 'foo')
const anchor = (): string => join(root, 'dsh-install')
const ctx = (): ReturnType<typeof contextForEntry> =>
  contextForEntry({
    id: 'a', name: 'dsh@a', version: '1.0.0', home: join(root, 'home'),
    execPath: join(anchor(), 'node_modules', '.bin', 'dsh.cmd'),
  })

/** Write a package.json (+ optional files, keys relative to `dir`). */
function writePkg(dir: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
}

/** The monorepo skeleton the tests resolve against. */
function makeMonorepo(): void {
  mkdirSync(repo(), { recursive: true })
  writeFileSync(join(repo(), 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  writePkg(pkgDir(), {
    name: '@me/dsh-foo',
    version: '0.1.0',
    exports: { '.': './dist/index.js' },
    peerDependencies: { '@deepseek-ai/dsh-base': '*' },
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }, { 'dist/index.js': 'export {}\n' })
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-dev-'))
  await openDatabase(join(root, 'app.sqlite'))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  saveSettings({ dshes: [], pluginDir: join(root, 'store'), devPlugins: [] })
  vi.mocked(installAnchor).mockReset()
  vi.mocked(installAnchor).mockReturnValue(anchor())
  vi.mocked(runPnpm).mockReset()
  vi.mocked(runPnpm).mockResolvedValue({ ok: true, text: 'done', command: 'pnpm run build' })
})

describe('findWorkspaceRoot', () => {
  it('walks up to the nearest pnpm workspace root', () => {
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
    writeFileSync(join(root, 'a', 'pnpm-workspace.yaml'), 'packages: []\n')
    expect(findWorkspaceRoot(join(root, 'a', 'b', 'c'))).toBe(join(root, 'a'))
  })
})

describe('registry', () => {
  it('records name/version/bundle + workspace root, dedupes, and never deletes source', () => {
    makeMonorepo()
    const dev = registerDevPlugin(pkgDir())
    expect(dev).toMatchObject({ name: '@me/dsh-foo', dir: pkgDir(), version: '0.1.0', bundle: true })
    expect(dev.workspaceRoot).toBe(repo())
    expect(listDevPlugins()).toHaveLength(1)

    registerDevPlugin(pkgDir()) // idempotent per package name
    expect(listDevPlugins()).toHaveLength(1)

    removeDevPlugin('@me/dsh-foo')
    expect(listDevPlugins()).toHaveLength(0)
    expect(existsSync(pkgDir())).toBe(true)
  })

  it('rejects a folder without a package manifest', () => {
    mkdirSync(join(root, 'empty'), { recursive: true })
    expect(() => registerDevPlugin(join(root, 'empty'))).toThrow()
  })
})

describe('diagnoseDevPlugin', () => {
  it('flags a missing build output as not built', () => {
    makeMonorepo()
    rmSync(join(pkgDir(), 'dist'), { recursive: true, force: true })
    expect(diagnoseDevPlugin(registerDevPlugin(pkgDir()), ctx()).entryMissing).toBe(true)
  })

  it('resolves the patch rows dsh loads, reporting the missing ones', () => {
    makeMonorepo()
    writeFileSync(join(pkgDir(), 'cordis.patch.yml'), [
      '- id: graph',
      '  name: "@me/dsh-graph"',
      '- id: gone',
      '  name: "@me/dsh-gone"',
      '',
    ].join('\n'))
    // A workspace link makes the sub-package resolvable from the bundle anchor.
    writePkg(join(pkgDir(), 'node_modules', '@me', 'dsh-graph'), { name: '@me/dsh-graph', version: '0.1.0' })

    const diag = diagnoseDevPlugin(registerDevPlugin(pkgDir()), ctx())
    expect(diag.patchRows).toEqual([
      {
        id: 'graph', name: '@me/dsh-graph', nameFrom: 'row',
        dir: join(pkgDir(), 'node_modules', '@me', 'dsh-graph'), root: 'monorepo', state: 'ok',
      },
      { id: 'gone', name: '@me/dsh-gone', nameFrom: 'row' },
    ])
    expect(diag.missingPatchRows).toEqual(['@me/dsh-gone'])
  })

  it('resolves a host package from the dsh install anchor and labels it host', () => {
    makeMonorepo()
    writeFileSync(join(pkgDir(), 'cordis.patch.yml'), '- id: web\n  name: "@deepseek-ai/dsh-web-app"\n')
    writePkg(join(anchor(), 'node_modules', '@deepseek-ai', 'dsh-web-app'), { name: '@deepseek-ai/dsh-web-app', version: '1.0.0' })

    const diag = diagnoseDevPlugin(registerDevPlugin(pkgDir()), ctx())
    expect(diag.missingPatchRows).toEqual([])
    expect(diag.patchRows).toEqual([{
      id: 'web',
      name: '@deepseek-ai/dsh-web-app',
      nameFrom: 'row',
      dir: join(anchor(), 'node_modules', '@deepseek-ai', 'dsh-web-app'),
      root: 'host',
      state: 'ok',
    }])
  })

  it('falls back to the shared profiles root (the host heal fallback)', () => {
    makeMonorepo()
    writeFileSync(join(pkgDir(), 'cordis.patch.yml'), '- id: ws\n  name: "@deepseek-ai/dsh-host-webserver"\n')
    writePkg(join(ctx().home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-host-webserver'), {
      name: '@deepseek-ai/dsh-host-webserver', version: '1.0.0',
    })

    const diag = diagnoseDevPlugin(registerDevPlugin(pkgDir()), ctx())
    expect(diag.patchRows[0]).toMatchObject({ root: 'host-fallback' })
    expect(diag.missingPatchRows).toEqual([])
  })

  it('reports @deepseek-ai peers that do not resolve from the dev package', () => {
    makeMonorepo()
    expect(diagnoseDevPlugin(registerDevPlugin(pkgDir()), ctx()).missingPeers).toEqual(['@deepseek-ai/dsh-base'])

    writePkg(join(pkgDir(), 'node_modules', '@deepseek-ai', 'dsh-base'), { name: '@deepseek-ai/dsh-base', version: '1.0.0' })
    const diag = diagnoseDevPlugin(registerDevPlugin(pkgDir()), ctx())
    expect(diag.missingPeers).toEqual([])
    expect(diag.peers).toEqual([{
      name: '@deepseek-ai/dsh-base',
      dir: join(pkgDir(), 'node_modules', '@deepseek-ai', 'dsh-base'),
      root: 'monorepo',
      state: 'ok',
    }])
  })
})

describe('peer shim', () => {
  it('satisfies a missing peer from the dsh install, reversibly', () => {
    makeMonorepo()
    writePkg(join(anchor(), 'node_modules', '@deepseek-ai', 'dsh-base'), { name: '@deepseek-ai/dsh-base', version: '1.0.0' })

    const dev = registerDevPlugin(pkgDir())
    expect(diagnoseDevPlugin(dev, ctx()).missingPeers).toEqual(['@deepseek-ai/dsh-base'])

    expect(shimDevPeers(dev, ctx()).added).toEqual(['@deepseek-ai/dsh-base'])
    const shimmed = listDevPlugins()[0]
    expect(shimmed.shims).toEqual(['@deepseek-ai/dsh-base'])
    expect(diagnoseDevPlugin(shimmed, ctx()).missingPeers).toEqual([])

    expect(unshimDevPeers(shimmed)).toEqual(['@deepseek-ai/dsh-base'])
    const cleaned = listDevPlugins()[0]
    expect(cleaned.shims ?? []).toEqual([])
    expect(diagnoseDevPlugin(cleaned, ctx()).missingPeers).toEqual(['@deepseek-ai/dsh-base'])
  })

  it('skips a peer the dsh install does not provide', () => {
    makeMonorepo()
    const dev = registerDevPlugin(pkgDir())
    expect(shimDevPeers(dev, ctx())).toEqual({ added: [], skipped: ['@deepseek-ai/dsh-base'] })
    expect(listDevPlugins()[0].shims ?? []).toEqual([])
  })
})

describe('build target', () => {
  it('prefers the package build, then the workspace root, then any script', () => {
    makeMonorepo()
    // Neither the package nor the repo root declares scripts.
    expect(defaultDevBuild(registerDevPlugin(pkgDir()))).toBeUndefined()

    // The aggregate case: the package declares none, the workspace root does.
    writePkg(repo(), { name: 'repo', private: true, scripts: { build: 'tsdown', lint: 'eslint' } })
    const ws = registerDevPlugin(pkgDir())
    expect(devScriptOptions(ws)).toEqual({ package: [], workspace: ['build', 'lint'] })
    expect(defaultDevBuild(ws)).toEqual({ script: 'build', scope: 'workspace' })

    // A package-level build wins over the workspace one.
    writePkg(pkgDir(), {
      name: '@me/dsh-foo', version: '0.1.0', scripts: { test: 'vitest', build: 'tsc' },
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    })
    const pkg = registerDevPlugin(pkgDir())
    expect(devScriptOptions(pkg)).toEqual({ package: ['build', 'test'], workspace: ['build', 'lint'] })
    expect(defaultDevBuild(pkg)).toEqual({ script: 'build', scope: 'package' })
  })

  it('runs at the workspace root when that is where the script lives, and remembers it', async () => {
    makeMonorepo()
    writePkg(repo(), { name: 'repo', private: true, scripts: { build: 'tsdown' } })
    const dev = registerDevPlugin(pkgDir())

    const result = await buildDevPlugin(dev)
    expect(result.command).toBe('pnpm run build')
    expect(result.cwd).toBe(repo())
    expect(vi.mocked(runPnpm).mock.calls[0]?.[0]).toBe(repo())
    expect(listDevPlugins()[0].build).toEqual({ script: 'build', scope: 'workspace' })
  })

  it('throws when neither the package nor its workspace declares scripts', async () => {
    makeMonorepo()
    await expect(buildDevPlugin(registerDevPlugin(pkgDir()))).rejects.toThrow()
  })
})

/**
 * Resolution against a host laid out the way pnpm installs one: the only
 * neighbour of `node_modules/@deepseek-ai` is the `dsh` package itself, and the
 * modules it depends on sit under that package's own `node_modules` chain. The
 * plain `<anchor>/node_modules/<name>` probe the diagnosis used to make finds
 * nothing there, which is why every host module used to read as missing.
 */
describe('resolution against a pnpm-shaped host', () => {
  /** The dsh package of the (mocked) install anchor. */
  const dshPkg = (): string => join(anchor(), 'node_modules', '@deepseek-ai', 'dsh')

  /** Give the dsh package a dependency, the way pnpm links one in. */
  function provide(name: string): void {
    writePkg(join(dshPkg(), 'node_modules', name), { name, version: '1.0.0' })
  }

  /** A bundle the profile composes, with its own id → package patch. */
  function makeBundle(bundle: string, rows: string): void {
    const dir = join(anchor(), 'node_modules', bundle)
    writePkg(dir, { name: bundle, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })
    writeFileSync(join(dir, 'cordis.patch.yml'), rows)
  }

  /** A profile manifest with bundles, so `listComboPlugins` has something to read. */
  function makeProfile(name: string, bundles: string[]): void {
    const dir = join(ctx().home, 'profiles', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `dsh-profile-${name}`, dependencies: {}, dsh: { profile: { bundles } },
    }))
  }

  it('resolves a host module through the dsh package chain', () => {
    makeMonorepo()
    writePkg(dshPkg(), { name: '@deepseek-ai/dsh', version: '1.0.0' })
    provide('@deepseek-ai/dsh-web-app')
    writeFileSync(join(pkgDir(), 'cordis.patch.yml'), '- id: web\n  name: "@deepseek-ai/dsh-web-app"\n')

    const diag = diagnoseDevPlugin(registerDevPlugin(pkgDir()), ctx())
    expect(diag.patchRows[0]).toMatchObject({
      root: 'host', state: 'ok', dir: join(dshPkg(), 'node_modules', '@deepseek-ai', 'dsh-web-app'),
    })
    expect(diag.missingPatchRows).toEqual([])
  })

  it('resolves an id-only row through the composition the target composes', () => {
    makeMonorepo()
    writePkg(dshPkg(), { name: '@deepseek-ai/dsh', version: '1.0.0' })
    provide('@deepseek-ai/cordis-plugin-timer')
    // `timer` → cordis-plugin-timer: the mapping is parsed, not prefixed.
    makeBundle('@deepseek-ai/dsh-base', '- id: timer\n  name: "@deepseek-ai/cordis-plugin-timer"\n')
    makeProfile('main', ['@deepseek-ai/dsh-base'])
    // The dev patch only ADDRESSES the id — the shape a composition patch really has.
    writeFileSync(join(pkgDir(), 'cordis.patch.yml'), '- id: timer\n  disabled: true\n')

    const diag = diagnoseDevPlugin(registerDevPlugin(pkgDir()), ctx(), { profile: 'main' })
    expect(diag.patchRows[0]).toMatchObject({
      id: 'timer',
      name: '@deepseek-ai/cordis-plugin-timer',
      nameFrom: 'index',
      from: '@deepseek-ai/dsh-base',
      root: 'host',
    })
    expect(diag.missingPatchRows).toEqual([])
    expect(diag.unknownIds).toEqual([])
    expect(diag.meta.profile).toBe('main')
  })

  it('lists an id no layer names as unknown rather than as a missing package', () => {
    makeMonorepo()
    writeFileSync(join(pkgDir(), 'cordis.patch.yml'), '- id: nobody-knows-me\n  disabled: true\n')
    const diag = diagnoseDevPlugin(registerDevPlugin(pkgDir()), ctx())
    expect(diag.patchRows[0]).toEqual({ id: 'nobody-knows-me', name: '', nameFrom: 'row' })
    expect(diag.unknownIds).toEqual(['nobody-knows-me'])
    expect(diag.missingPatchRows).toEqual([])
  })

  it('reports a link whose target is gone instead of calling it missing', () => {
    makeMonorepo()
    writeFileSync(join(pkgDir(), 'cordis.patch.yml'), '- id: web\n  name: "@deepseek-ai/dsh-web-app"\n')
    const scope = join(ctx().home, 'profiles', 'node_modules', '@deepseek-ai')
    mkdirSync(scope, { recursive: true })
    const broken = join(root, 'previous-version-store')
    try {
      symlinkSync(broken, join(scope, 'dsh-web-app'), 'junction')
    } catch {
      return // a filesystem that refuses junctions: nothing to assert here
    }

    const dev = registerDevPlugin(pkgDir())
    const row = diagnoseDevPlugin(dev, ctx()).patchRows[0]
    expect(row).toMatchObject({ root: 'host-fallback', state: 'dangling' })
    expect(row.link).toBe(broken)
    // A dangling entry is a package that cannot be imported, so the row still
    // counts as missing too — the two facts coexist on purpose.
    expect(diagnoseDevPlugin(dev, ctx()).missingPatchRows).toEqual(['@deepseek-ai/dsh-web-app'])
  })

  it('lists unscoped declared dependencies, not just @deepseek-ai ones', () => {
    makeMonorepo()
    writePkg(pkgDir(), {
      name: '@me/dsh-foo', version: '0.1.0', exports: { '.': './dist/index.js' },
      dependencies: { hono: '^4.0.0' }, dsh: { bundle: { patch: 'cordis.patch.yml' } },
    })
    writeFileSync(join(pkgDir(), 'cordis.patch.yml'), '')
    writePkg(join(ctx().home, 'profiles', 'node_modules', 'hono'), { name: 'hono', version: '4.0.0' })

    const diag = diagnoseDevPlugin(registerDevPlugin(pkgDir()), ctx())
    expect(diag.peers.map(p => p.name)).toEqual(['hono'])
    expect(diag.peers[0]).toMatchObject({ root: 'host-fallback', state: 'ok' })
    expect(diag.missingPeers).toEqual(['hono'])
  })

  it('resolves a subpath row by its package instead of calling it missing', () => {
    makeMonorepo()
    writePkg(dshPkg(), { name: '@deepseek-ai/dsh', version: '1.0.0' })
    provide('@deepseek-ai/dsh-web-app')
    writeFileSync(join(pkgDir(), 'cordis.patch.yml'), '- id: startup\n  name: "@deepseek-ai/dsh-web-app/startup"\n')

    const diag = diagnoseDevPlugin(registerDevPlugin(pkgDir()), ctx())
    expect(diag.patchRows[0]).toMatchObject({
      name: '@deepseek-ai/dsh-web-app/startup', pkg: '@deepseek-ai/dsh-web-app', root: 'host',
    })
    expect(diag.missingPatchRows).toEqual([])
  })

  it('serves a cached report until a layer file changes or refresh is asked', () => {
    makeMonorepo()
    writeFileSync(join(pkgDir(), 'cordis.patch.yml'), '- id: web\n  name: "@deepseek-ai/dsh-web-app"\n')
    const dev = registerDevPlugin(pkgDir())

    const first = cachedDiagnosis(dev, ctx())
    expect(cachedDiagnosis(dev, ctx())).toBe(first)          // a hit, not a recompute
    expect(cachedDiagnosis(dev, ctx(), { refresh: true })).not.toBe(first)

    // Editing the patch must miss the cache even without `refresh`: this dialog
    // exists to be re-run while editing exactly that file.
    const later = new Date(Date.now() + 2000)
    utimesSync(join(pkgDir(), 'cordis.patch.yml'), later, later)
    expect(cachedDiagnosis(dev, ctx())).not.toBe(first)
  })

  it('reports the chain it ran against, so a cached verdict keeps its identity', () => {
    makeMonorepo()
    const diag = diagnoseDevPlugin(registerDevPlugin(pkgDir()), ctx(), {
      dsh: { id: 'dsh-1', name: 'official', version: '1.2.3' },
    })
    expect(diag.meta).toMatchObject({ dshId: 'dsh-1', dshName: 'official', dshVersion: '1.2.3' })
    expect(diag.meta.profile).toBeUndefined()
    expect(Number.isNaN(Date.parse(diag.meta.at))).toBe(false)
  })
})
