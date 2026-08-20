/**
 * Plugin store: a configurable directory managed by pnpm. `pnpm add` installs
 * npm-package or git sources as dependencies; `pnpm remove` uninstalls.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import AdmZip from 'adm-zip'
import { runPnpm, type PnpmResult } from './pnpm.ts'
import { logger } from './logger.ts'
import { profilesDir } from './home.ts'
import type { InstalledOverviewRow } from './types.ts'
import type { DshScope } from './appState.ts'

/** A dsh scope whose profiles we scan for usage. Re-exported for prior callers. */
export type { DshScope } from './appState.ts'

function readVersion(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }
    return pkg.version
  } catch {
    return undefined
  }
}

/** Version of a package currently installed in the store, or `undefined`. Used
 * to decide whether an npm bundle can be satisfied by an already-downloaded
 * plugin instead of re-fetching it. */
export function installedStoreVersion(storeDir: string, name: string): string | undefined {
  if (storeDir === '') return undefined
  return readVersion(join(storeDir, 'node_modules', name))
}

interface ProfileManifestShape {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] }; bundle?: { patch?: string } }
}

interface StoreManifest {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
}

/** Ensure the store directory is a pnpm project with an empty manifest. */
export function initStore(dir: string): void {
  logger.debug(`plugin store ensured: ${dir}`)
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest: StoreManifest = { name: 'plugin-store', private: true, dependencies: {} }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }
}

/** List installed plugin names and versions from the store manifest. */
export function listPlugins(dir: string): { name: string; version: string }[] {
  if (dir === '') return [] // no store configured — never fall back to cwd
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StoreManifest
  return Object.entries(manifest.dependencies ?? {}).map(([name, version]) => ({ name, version }))
}

/** Install one source (npm package name or git spec) into the store. */
export async function addPlugin(dir: string, source: string): Promise<PnpmResult> {
  if (dir === '') return { ok: false, text: '未配置插件保存位置 —— 请在「设置」中指定' }
  initStore(dir)
  // 网络差时重试 fetch，避免一次抖动就得到一个残缺安装。
  const result = await runPnpm(dir, ['add', source, '--fetch-retries=3', '--fetch-retry-maxtimeout=60000'])
  if (result.ok) logger.info(`plugin store add: ${source}`)
  return result
}

/** Uninstall one plugin by package name from the store. */
export async function removePlugin(dir: string, name: string): Promise<PnpmResult> {
  if (dir === '') return { ok: false, text: '未配置插件保存位置 —— 请在「设置」中指定' }
  initStore(dir)
  const result = await runPnpm(dir, ['remove', name])
  if (result.ok) logger.info(`plugin store remove: ${name}`)
  return result
}

/** Locate the top-most directory holding a `package.json`, walking one level
 * deep — a zip often wraps the plugin in a single folder. */
function packageRoot(dir: string): string | undefined {
  if (existsSync(join(dir, 'package.json'))) return dir
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sub = join(dir, entry.name)
    if (existsSync(join(sub, 'package.json'))) return sub
  }
  return undefined
}

/**
 * Install a plugin from a LOCAL source into the store. `path` may be a plugin
 * folder, or a `.zip` that gets extracted (to `storeDir/.import/<name>`, kept
 * so the recorded `file:` dependency stays resolvable) into its package root.
 * Then it is added just like a network source via `pnpm add file:<root>`,
 * so it flows through the exact same store → link → profile pipeline.
 */
export async function addLocalPlugin(storeDir: string, path: string): Promise<PnpmResult> {
  if (storeDir === '') return { ok: false, text: '未配置插件保存位置 —— 请在「设置」中指定' }
  if (!existsSync(path)) return { ok: false, text: `路径不存在：${path}` }

  let source: string
  if (statSync(path).isDirectory()) {
    source = path
  } else {
    if (!path.toLowerCase().endsWith('.zip')) return { ok: false, text: `${path} 不是 .zip 包` }
    const dest = join(storeDir, '.import', basename(path).replace(/\.zip$/i, '') || 'plugin')
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    try {
      new AdmZip(path).extractAllTo(dest, true)
    } catch (error) {
      return { ok: false, text: `解压失败：${String(error instanceof Error ? error.message : error)}` }
    }
    const root = packageRoot(dest)
    if (root === undefined) return { ok: false, text: 'zip 内未找到插件包（缺少 package.json）' }
    source = root
  }

  if (!existsSync(join(source, 'package.json'))) return { ok: false, text: '不是有效的插件包（缺少 package.json）' }
  initStore(storeDir)
  return runPnpm(storeDir, ['add', `file:${source}`])
}

/** Resolve a plugin's top-level README filename (case-insensitive), if any. */
const README_NAMES = ['README.md', 'readme.md', 'README.MD', 'README', 'readme']

/** Read a plugin's README markdown, or `''` when none exists (or it is missing). */
export function readPluginReadme(dshes: DshScope[], storeDir: string, name: string): string {
  const dir = findInstalledDir(dshes, storeDir, name)
  if (dir === undefined) return ''
  for (const fileName of README_NAMES) {
    const p = join(dir, fileName)
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf8') } catch { return '' }
    }
  }
  return ''
}

/** DSH → profiles lists for the "install into a profile" picker. */
export function listProfileScopes(dshes: DshScope[]): { id: string; name: string; version?: string; profiles: string[] }[] {
  return dshes.map(dsh => {
    const dir = dsh.profilesDir ?? join(dsh.home, 'profiles')
    const profiles: string[] = []
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(dir, entry.name, 'package.json'))) profiles.push(entry.name)
      }
    }
    return { id: dsh.id, name: dsh.name, version: dsh.version, profiles: profiles.sort() }
  })
}

/** Locate a plugin's on-disk install dir (store first, else the first profile
 * that uses it). Used for "reveal in file explorer". */
export function findInstalledDir(dshes: DshScope[], storeDir: string, name: string): string | undefined {
  if (storeDir !== '') {
    const storePkg = join(storeDir, 'node_modules', name)
    if (existsSync(join(storePkg, 'package.json'))) return storePkg
  }
  for (const dsh of dshes) {
    const dir = dsh.profilesDir ?? join(dsh.home, 'profiles')
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pkg = join(dir, entry.name, 'node_modules', name)
      if (existsSync(join(pkg, 'package.json'))) return pkg
    }
  }
  return undefined
}

/**
 * Build the installed-plugin overview: the union of every plugin that is
 * actually in use across all dsh scopes' profiles (their bundle layers plus
 * installed bundle-declaring dependencies), with the store-flag and the versions
 * observed. A "downloaded but unused" store-only package stays listed too, so
 * nothing is hidden.
 */
export function buildInstalledOverview(dshes: DshScope[], storeDir: string): InstalledOverviewRow[] {
  const rows = new Map<string, InstalledOverviewRow>()
  const getRow = (name: string): InstalledOverviewRow => {
    let row = rows.get(name)
    if (row === undefined) {
      row = { name, versions: [], usage: [], inStore: false }
      rows.set(name, row)
    }
    return row
  }
  const noteVersion = (row: InstalledOverviewRow, version: string | undefined): void => {
    if (version !== undefined && version !== '' && !row.versions.includes(version)) row.versions.push(version)
  }

  // In-use across every dsh scope.
  for (const dsh of dshes) {
    const dir = dsh.profilesDir ?? join(dsh.home, 'profiles')
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const profile = entry.name
      const manifestPath = join(dir, profile, 'package.json')
      if (!existsSync(manifestPath)) continue
      let manifest: { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch {
        continue
      }
      const bundles = manifest.dsh?.profile?.bundles ?? []
      const deps = Object.keys(manifest.dependencies ?? {})
      const pkgNodeModules = join(dir, profile, 'node_modules')
      const scan: string[] = []
      for (const b of bundles) scan.push(b)
      for (const d of deps) {
        // An installed dependency that declares a bundle counts as in use too.
        if (existsSync(join(pkgNodeModules, d, 'package.json'))) scan.push(d)
      }
      // Dedupe within one profile: a package may appear in both the bundle layer
        // and dependencies — that is one usage point, not two.
        const seenInProfile = new Set<string>()
        for (const name of scan) {
          if (name === 'node_modules' || seenInProfile.has(name)) continue
          seenInProfile.add(name)
          const row = getRow(name)
          row.usage.push({ dsh: dsh.name, dshVersion: dsh.version, profile })
          noteVersion(row, readVersion(join(pkgNodeModules, name)))
        }
    }
  }

  // Store-local downloads.
  if (storeDir !== '') {
    const storeManifestPath = join(storeDir, 'package.json')
    if (existsSync(storeManifestPath)) {
      try {
        const store = JSON.parse(readFileSync(storeManifestPath, 'utf8')) as { dependencies?: Record<string, string> }
        for (const name of Object.keys(store.dependencies ?? {})) {
          const row = getRow(name)
          row.inStore = true
          noteVersion(row, readVersion(join(storeDir, 'node_modules', name)))
        }
      } catch {
        // ignore unreadable store manifest
      }
    }
  }

  // A package that's in use but not in the store is a dsh-bundled template
  // (e.g. @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app) — mark it as built-in,
  // not a plugin the user can manage/uninstall from the store.
  return [...rows.values()]
    .map(row => ({ ...row, builtin: row.inStore !== true && row.usage.length > 0 }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Point a profile at a locally-downloaded plugin in the store via a `link:`
 * dependency, run the profile's pnpm install, and reconcile bundles.
 *
 * Returns `{ ok, text, activated }` where `activated` tells whether the plugin
 * declared `dsh.bundle` and was appended to the profile's bundle layer.
 */
export async function installIntoProfile(
  profile: string, pkg: string, storeDir: string, baseProfilesDir?: string,
): Promise<{ ok: boolean; text: string; activated: boolean }> {
  if (storeDir === '') return { ok: false, text: '未配置插件保存位置 —— 请在「设置」中指定', activated: false }
  const dir = join(baseProfilesDir ?? profilesDir(), profile)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return { ok: false, text: `profile "${profile}" 不存在`, activated: false }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifestShape
  manifest.dependencies = manifest.dependencies ?? {}
  const spec = `link:${join(storeDir, 'node_modules', pkg)}`
  if (manifest.dependencies[pkg] !== spec) {
    manifest.dependencies[pkg] = spec
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }

  const install = await runPnpm(dir, ['install'])
  if (!install.ok) return { ok: false, text: `pnpm install 失败：${install.text}`, activated: false }

  // Bundle reconcile: a dependency that declares `dsh.bundle` joins the layer.
  const storeManifestPath = join(storeDir, 'node_modules', pkg, 'package.json')
  if (!existsSync(storeManifestPath)) return { ok: true, text: `已作为 link 依赖安装（${pkg}）`, activated: false }
  let installed: ProfileManifestShape
  try {
    installed = JSON.parse(readFileSync(storeManifestPath, 'utf8')) as ProfileManifestShape
  } catch {
    return { ok: true, text: `已作为 link 依赖安装（${pkg}）`, activated: false }
  }
  if (installed.dsh?.bundle?.patch === undefined) {
    return { ok: true, text: `已作为普通 link 依赖安装（${pkg}，声明无 dsh.bundle）`, activated: false }
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(pkg)) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, pkg] } }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    return { ok: true, text: `已激活：${pkg} 声明了 dsh.bundle，已加入 bundle 层`, activated: true }
  }
  return { ok: true, text: `已在 bundle 层（${pkg}）`, activated: true }
}