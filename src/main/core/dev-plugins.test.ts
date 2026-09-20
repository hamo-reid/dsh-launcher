/**
 * Dev plugins: the settings-backed registry (independent of the store),
 * patch-driven resolution diagnosis, and the reversible peer shim.
 * `installAnchor` is mocked so the shim can be exercised against a disposable
 * tree instead of a real dsh install.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('./home.ts', async (importActual) => {
  const actual = await importActual<typeof import('./home.ts')>()
  return { ...actual, installAnchor: vi.fn() }
})

import { installAnchor } from './home.ts'
import { openDatabase, saveSettings } from './settings.ts'
import { contextForEntry } from './appState.ts'
import {
  diagnoseDevPlugin, findWorkspaceRoot, listDevPlugins, registerDevPlugin, removeDevPlugin, shimDevPeers, unshimDevPeers,
} from './dev-plugins.ts'

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
      { id: 'graph', name: '@me/dsh-graph', dir: join(pkgDir(), 'node_modules', '@me', 'dsh-graph'), root: 'monorepo' },
      { id: 'gone', name: '@me/dsh-gone' },
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
      dir: join(anchor(), 'node_modules', '@deepseek-ai', 'dsh-web-app'),
      root: 'host',
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
