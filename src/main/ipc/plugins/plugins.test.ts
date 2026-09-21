/**
 * Dev-plugin diagnosis against an EXPLICIT host.
 *
 * Patch rows and peers resolve through the chosen dsh's chain (its install
 * anchor → shared profiles → home), so with several dsh versions installed the
 * caller's choice has to decide the answer. These tests register two installs
 * that provide the same package at DIFFERENT paths and check that the verdict
 * follows the requested host — and that an unknown host is refused rather than
 * silently swapped for another dsh.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../core/settings/settings.ts'
import { updateDshState } from '../../core/profile/appState.ts'
import { registerDevPlugin } from '../../core/store/dev.ts'
import { registerPluginsIpc } from './plugins.ts'
import type { DevDiagnoseOptions, DevDiagnosis, IpcResult } from '../../../shared/types.ts'

/** Every registered channel, so a test can invoke one without ipcMain. */
const channels = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  dialog: {},
  shell: {},
  BrowserWindow: { getFocusedWindow: () => null },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void => {
      channels.set(channel, fn)
    },
  },
}))

let root: string
/** `<root>/install-<n>` with a package.json (the install anchor) and a bin. */
const installDir = (n: string): string => join(root, `install-${n}`)
const binPath = (n: string): string => join(installDir(n), 'node_modules', '.bin', 'dsh.cmd')

/** The `@deepseek-ai/*` package only this install provides. */
function provideHostPackage(n: string, pkg: string): void {
  const dir = join(installDir(n), 'node_modules', pkg)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0' }))
}

function mkInstall(n: string): string {
  mkdirSync(join(installDir(n), 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(installDir(n), 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' }))
  writeFileSync(binPath(n), '')
  return binPath(n)
}

async function diagnose(name: string, opts?: DevDiagnoseOptions): Promise<IpcResult<DevDiagnosis>> {
  const fn = channels.get('plugins:devDiagnose')
  if (fn === undefined) throw new Error('plugins:devDiagnose was not registered')
  return await fn({}, name, opts) as IpcResult<DevDiagnosis>
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-plugins-ipc-'))
  await openDatabase(join(root, 'app.sqlite'))
  const a = mkInstall('a')
  const b = mkInstall('b')
  provideHostPackage('a', '@deepseek-ai/dsh-web-app')
  provideHostPackage('b', '@deepseek-ai/dsh-web-app')
  updateDshState(() => [
    { id: a, name: 'dsh@1.0.0', execPath: a, version: '1.0.0', home: join(root, 'home-a') },
    { id: b, name: 'dsh@2.0.0', execPath: b, version: '2.0.0', home: join(root, 'home-b') },
  ])
  // A dev bundle whose patch loads a package both installs happen to provide.
  const pkgDir = join(root, 'repo', 'packages', 'foo')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: '@me/dsh-foo', version: '0.1.0', exports: { '.': './dist/index.js' }, dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), '- id: web\n  name: "@deepseek-ai/dsh-web-app"\n')
  registerDevPlugin(pkgDir)
  registerPluginsIpc()
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('plugins:devDiagnose host selection', () => {
  it('resolves the patch row from the dsh the caller picked', async () => {
    const viaB = await diagnose('@me/dsh-foo', { dshId: binPath('b') })
    expect(viaB.ok && viaB.value.patchRows[0]).toMatchObject({
      root: 'host', dir: join(installDir('b'), 'node_modules', '@deepseek-ai', 'dsh-web-app'),
    })
    const viaA = await diagnose('@me/dsh-foo', { dshId: binPath('a') })
    expect(viaA.ok && viaA.value.patchRows[0]).toMatchObject({
      root: 'host', dir: join(installDir('a'), 'node_modules', '@deepseek-ai', 'dsh-web-app'),
    })
  })

  it('refuses a host that is not registered instead of substituting another', async () => {
    expect(await diagnose('@me/dsh-foo', { dshId: join(root, 'gone') }))
      .toMatchObject({ ok: false, code: 'dsh.notFound' })
  })

  it('refuses an unknown profile and accepts a real one', async () => {
    expect(await diagnose('@me/dsh-foo', { dshId: binPath('a'), profile: 'nope' }))
      .toMatchObject({ ok: false, code: 'profile.notFound' })
    // A real profile is a directory with a manifest (that is what `listProfiles`
    // recognises), and it comes back in the report's provenance.
    const p = join(root, 'home-a', 'profiles', 'main')
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'dsh-profile-main', dsh: { profile: { bundles: [] } } }))
    const r = await diagnose('@me/dsh-foo', { dshId: binPath('a'), profile: 'main' })
    expect(r.ok && r.value.meta).toMatchObject({ profile: 'main', dshName: 'dsh@1.0.0', dshVersion: '1.0.0' })
  })

  it('resolves an id-only row through the composition it targets', async () => {
    // A row that only ADDRESSES an id: the package has to come from the index.
    const p = join(root, 'home-a', 'profiles', 'main')
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'package.json'), JSON.stringify({
      name: 'dsh-profile-main',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }))
    const bundle = join(p, 'node_modules', '@deepseek-ai', 'dsh-base')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-base', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(bundle, 'cordis.patch.yml'), '- id: web\n  name: "@deepseek-ai/dsh-web-app"\n')
    const devPatch = join(root, 'repo', 'packages', 'foo', 'cordis.patch.yml')
    const before = readFileSync(devPatch, 'utf8')
    writeFileSync(devPatch, '- id: web\n  disabled: true\n')
    try {
      const r = await diagnose('@me/dsh-foo', { dshId: binPath('a'), profile: 'main', refresh: true })
      expect(r.ok && r.value.patchRows[0]).toMatchObject({
        id: 'web', name: '@deepseek-ai/dsh-web-app', nameFrom: 'index', from: '@deepseek-ai/dsh-base',
      })
    } finally {
      writeFileSync(devPatch, before)
    }
  })

  it('falls back to the first registered dsh only when no host is given', async () => {
    const implicit = await diagnose('@me/dsh-foo')
    expect(implicit.ok && implicit.value.patchRows[0]).toMatchObject({ dir: join(installDir('a'), 'node_modules', '@deepseek-ai', 'dsh-web-app') })
  })
})
