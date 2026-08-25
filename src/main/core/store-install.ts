/**
 * Installing plugins into the store and linking them into profiles. A download
 * is staged into a per-plugin mini pnpm project, hoisted to
 * `archive/<name>/<version>/`, and a profile's `link:` dependency then points at
 * that versioned copy (with bundle-layer reconcile for bundle-declaring plugins).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import AdmZip from 'adm-zip'
import { runPnpm, type PnpmResult } from './pnpm.ts'
import { logger } from './logger.ts'
import { profilesDir } from './home.ts'
import {
  archivedPluginNames, initStore, latestStoreVersion, pluginVersionDir, readVersion, storeVersions,
  versionStagingDir, versionsRoot, type ProfileManifestShape,
} from './store-layout.ts'
import { recordPluginSource, sourceKindOf } from './store-sources.ts'
import { migrateLegacyStore } from './store-migration.ts'
import { isLegacyPkg } from './store-uninstall.ts'
import { listBundleSubdepNames } from './bundle-subdeps.ts'

/**
 * pnpm settings an archived aggregate version needs to expose its sub-packages
 * at the top-level node_modules. Archives default to pnpm's `isolated` linker,
 * which stows every dependency behind `.pnpm/` and leaves only the top package
 * visible — so an aggregate bundle's sub-bundles are invisible to a profile link.
 * Hoisting matches dsh's own profile workspace, making `node_modules/<sub>` real.
 */
const ARCHIVE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** Whether an installed package's manifest declares a `dsh.bundle` patch. */
function declaresBundlePatch(pkgDir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    return manifest.dsh?.bundle?.patch !== undefined
  } catch {
    return false
  }
}

/** Write the hoisted pnpm workspace into an archive's own project, unless present. */
function writeHoistedWorkspace(verDir: string): boolean {
  const p = join(verDir, 'pnpm-workspace.yaml')
  if (existsSync(p)) return false
  writeFileSync(p, ARCHIVE_PNPM_WORKSPACE)
  return true
}

/** Derive a package-name hint from a download source (`name@ver`, `name`, or a
 * `github:owner/repo` spec — brand guess for the repo tail). */
export function packageNameFromSource(source: string): string {
  const trimmed = source.trim()
  const pure = trimmed.replace(/^github:/, '')
  if (trimmed.startsWith('github:')) {
    return pure.split('#')[0].split('/')[1] ?? 'plugin'
  }
  // @scope/pk@ver | pk@ver | @scope/pk | pk
  const scoped = pure.startsWith('@')
  const body = scoped ? pure.slice(1) : pure
  const nameOnly = body.split('@')[0]
  return (scoped ? '@' : '') + nameOnly
}

/** Install one source (npm package or git spec) into the store. Downloads into a
 * per-plugin staging mini project, then hoists it to its version-named directory
 * under `archive/<name>/<version>/`, so multiple versions can coexist and each
 * is a self-contained pnpm project. Re-downloading an already-archived version
 * is a no-op (idempotent). */
export async function addPlugin(dir: string, source: string, name?: string): Promise<PnpmResult> {
  if (dir === '') return { ok: false, text: '未配置插件保存位置 —— 请在「设置」中指定' }
  return installSource(dir, name ?? packageNameFromSource(source), source)
}

/** Shared download path: build the source into a staging project, read the real
 * version, then hoist the whole project to `archive/<name>/<version>/`. */
export async function installSource(storeDir: string, name: string, source: string, signal?: AbortSignal): Promise<PnpmResult> {
  if (name.trim() === '') return { ok: false, text: '未能确定插件包名' }
  // Never add a version alongside a legacy flat package for the same plugin —
  // absorb old packages into the versioned layout first (and retarget any
  // profiles that link into a moved package).
  await migrateLegacyStore(storeDir)
  initStore(storeDir)
  const staging = versionStagingDir(storeDir, name)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  initStore(staging) // a minimal project for `pnpm add` to resolve into
  const result = await runPnpm(staging, ['add', source, '--fetch-retries=3', '--fetch-retry-maxtimeout=60000'], signal, { storeDir })
  // A user cancel: drop the half-downloaded staging dir and surface it as a
  // cancel, not a failure — the download task manager treats it as cancelled.
  if (result.aborted === true) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, aborted: true, text: 'cancelled' }
  }
  if (!result.ok) {
    rmSync(staging, { recursive: true, force: true })
    return result
  }
  const version = readVersion(join(staging, 'node_modules', name))
  if (version === undefined) {
    // pnpm may have reported success while the package never landed (e.g. a
    // resolution failure whose `added 0` slipped the fallible check above). Keep
    // pnpm's own tail so the user sees the real reason, not a guess at it.
    const tail = result.text.trim().split(/\r?\n/).slice(-4).join(' ')
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, text: `未在 node_modules 中找到 ${name}（包名不匹配，或依赖解析失败）${tail !== '' ? `\n${tail}` : ''}` }
  }
  // Detect an aggregate bundle HERE, while the staging `node_modules/<name>` link is
  // still valid. After the rename its absolute link dangles (naming the gone
  // `.staging`), so inspecting it post-rename would read a broken package and miss
  // the bundle — leaving an aggregate version isolated (invisible sub-packages).
  const isAggregate = declaresBundlePatch(join(staging, 'node_modules', name))
  const dest = pluginVersionDir(storeDir, name, version)
  if (existsSync(dest)) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: true, text: `已在该版本（${name}@${version}）` }
  }
  mkdirSync(dirname(dest), { recursive: true })
  try {
    renameSync(staging, dest)
  } catch (error) {
    return { ok: false, text: `归档失败：${error instanceof Error ? error.message : String(error)}` }
  }
  // An aggregate bundle version must be hoisted so its sub-packages surface at the
  // top-level node_modules. Write the workspace before the rewire below so the
  // `pnpm install` materialises those links against this version's own goods.
  if (isAggregate) writeHoistedWorkspace(dest)
  // Moving `.staging` → version dir dangles pnpm's absolute top-level links (they
  // name the now-gone `.staging`); let pnpm rewire them to this version's goods.
  await reinstallVersion(dest, join(dest, 'node_modules', name), storeDir)
  recordPluginSource(storeDir, name, version, sourceKindOf(source))
  logger.info(`plugin store add: ${name}@${version} (${source})`)
  return { ok: true, text: `已下载 ${name}@${version}` }
}

/** Rewire an archived version's top-level node_modules links after the staging
 * dir was moved to its final location. pnpm writes those top-level links as
 * absolute targets naming `.staging`, so the rename invalidates them; a reinstall
 * rebuilds them against this version's own `.pnpm` goods. Needs
 * `confirmModulesPurge=false`: pnpm sees a moved project as needing a full
 * rebuild, and would otherwise wait on an interactive prompt in a non-CI child.
 *
 * When `pkgDir` is given (`node_modules/<name>`), a stale pnpm lock can mark the
 * install "up to date" while a dangling top-level link stays broken — pnpm trusts
 * `.modules.yaml` and never re-checks the junction target. So if the package body
 * is still unreadable after the normal offline/online installs, a `--force` relink
 * rebuilds it. */
async function reinstallVersion(verDir: string, pkgDir?: string, storeDir?: string): Promise<boolean> {
  const storeOpts = storeDir === undefined ? undefined : { storeDir }
  const bodyOk = (): boolean => pkgDir === undefined || existsSync(join(pkgDir, 'package.json'))
  const offline = await runPnpm(verDir, ['install', '--offline', '--prefer-offline', '--config.confirmModulesPurge=false'], undefined, storeOpts)
  if (offline.ok && bodyOk()) return true
  const online = await runPnpm(verDir, ['install', '--config.confirmModulesPurge=false', '--fetch-retries=3', '--fetch-retry-maxtimeout=60000'], undefined, storeOpts)
  if (online.ok && bodyOk()) return true
  const forced = await runPnpm(verDir, ['install', '--force', '--config.confirmModulesPurge=false', '--fetch-retries=3', '--fetch-retry-maxtimeout=60000'], undefined, storeOpts)
  if (forced.ok && bodyOk()) return true
  logger.warn(`plugin store: failed to rewire links in ${verDir}: ${offline.text || online.text || forced.text}`)
  return false
}

/** Re-wire every archived version whose top-level package link is broken (e.g.
 * left over from before this re-link existed, or an interrupted download). Runs
 * on startup so previously-downloaded plugins surface again. Healthy versions
 * are skipped, so a clean store is a read-only no-op. */
export async function repairArchiveLinks(storeDir: string): Promise<void> {
  if (storeDir === '') return
  const vRoot = versionsRoot(storeDir)
  if (!existsSync(vRoot)) return
  for (const name of archivedPluginNames(storeDir)) {
    const root = join(vRoot, name)
    for (const v of readdirSync(root, { withFileTypes: true })) {
      if (!v.isDirectory() || v.name === '.staging') continue
      const verDir = join(root, v.name)
      const pkgDir = join(verDir, 'node_modules', name)
      // Migrate aggregate versions (whose sub-packages the re-link would otherwise
      // leave invisible behind pnpm's isolated linker) to a hoisted layout.
      if (declaresBundlePatch(pkgDir) && !existsSync(join(verDir, 'pnpm-workspace.yaml'))) {
        writeHoistedWorkspace(verDir)
        logger.info(`plugin store: hoisting aggregate archive ${name}@${v.name}`)
        await reinstallVersion(verDir, pkgDir, storeDir)
        continue
      }
      if (existsSync(join(pkgDir, 'package.json'))) continue
      logger.info(`plugin store: rewiring broken archive ${name}@${v.name}`)
      await reinstallVersion(verDir, pkgDir, storeDir)
    }
  }
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
  const srcName = (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name?: string }).name
  if (!srcName) return { ok: false, text: '插件包缺少 name 字段' }
  return installSource(storeDir, srcName, `file:${source}`)
}

/** Resolve the versioned node_modules dir for an archived plugin, or null. */
function targetVersionedPkgDir(storeDir: string, pkg: string, opts: { version?: string }): string | null {
  const version = opts.version ?? latestStoreVersion(storeDir, pkg)
  if (version === undefined) return null
  return join(pluginVersionDir(storeDir, pkg, version), 'node_modules', pkg)
}

/**
 * Point a profile at one archived version of a plugin via a `file:` dependency,
 * so pnpm real-installs it (plus any sub-bundles) into the profile node_modules,
 * then runs pnpm install and reconciles bundles. `version` selects the specific
 * archived copy; when omitted, the highest archived version is used. Real
 * install (not a store `link:`) matters because dsh plugins import `@deepseek-ai/*`
 * services that dsh's heal fallback provides from the profile — a store link
 * would resolve those peers up the store tree and fail.
 */
export async function installIntoProfile(
  profile: string, pkg: string, storeDir: string, baseProfilesDir?: string,
  opts: { version?: string } = {},
): Promise<{ ok: boolean; text: string; activated: boolean }> {
  if (storeDir === '') return { ok: false, text: '未配置插件保存位置 —— 请在「设置」中指定', activated: false }
  // A legacy store keeps its plugin at the flat node_modules root (no version dir
  // — its deps are hoisted there); link it straight, ignoring any version pick.
  const legacyOnly = storeVersions(storeDir, pkg).length === 0 && isLegacyPkg(storeDir, pkg)
  const pkgDir = legacyOnly
    ? join(storeDir, 'node_modules', pkg)
    : targetVersionedPkgDir(storeDir, pkg, opts)
  if (pkgDir === null) {
    return { ok: false, text: `${pkg} 尚未在插件库中，请先下载再安装`, activated: false }
  }
  const dir = join(baseProfilesDir ?? profilesDir(), profile)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return { ok: false, text: `profile "${profile}" 不存在`, activated: false }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifestShape
  manifest.dependencies = manifest.dependencies ?? {}
  // Depend on the archived copy via `file:` so pnpm INSTALLS it into the profile's
  // node_modules (real package bodies, not a junction to the store). dsh loads
  // plugins from the profile dir, and they import @deepseek-ai/dsh-* services that
  // dsh's heal fallback ($HOME/profiles/node_modules) provides; a `link:` to the
  // store resolves those peers up the STORE tree and fails. file: real-installs the
  // package (and its sub-bundles) into the profile, so peers resolve through the
  // profile → heal-fallback chain.
  const spec = `file:${pkgDir}`
  let manifestChanged = manifest.dependencies[pkg] !== spec
  if (manifestChanged) manifest.dependencies[pkg] = spec
  // Drop any stale sub-bundle deps injected by the earlier link-based install —
  // pnpm now real-installs them itself as deps of the file: package.
  for (const sub of listBundleSubdepNames(pkgDir)) {
    if (manifest.dependencies[sub] !== undefined) {
      delete manifest.dependencies[sub]
      manifestChanged = true
    }
  }
  if (manifestChanged) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  const install = await runPnpm(dir, ['install', '--config.confirmModulesPurge=false'], undefined, { storeDir })
  if (!install.ok) return { ok: false, text: `pnpm install 失败：${install.text}`, activated: false }

  // Bundle reconcile: a dependency that declares `dsh.bundle` joins the layer.
  const storeManifestPath = join(pkgDir, 'package.json')
  if (!existsSync(storeManifestPath)) return { ok: true, text: `已作为 file 依赖安装（${pkg}）`, activated: false }
  let installed: ProfileManifestShape
  try {
    installed = JSON.parse(readFileSync(storeManifestPath, 'utf8')) as ProfileManifestShape
  } catch {
    return { ok: true, text: `已作为 file 依赖安装（${pkg}）`, activated: false }
  }
  if (installed.dsh?.bundle?.patch === undefined) {
    return { ok: true, text: `已作为普通 file 依赖安装（${pkg}，声明无 dsh.bundle）`, activated: false }
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(pkg)) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, pkg] } }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    return { ok: true, text: `已激活：${pkg} 声明了 dsh.bundle，已加入 bundle 层`, activated: true }
  }
  return { ok: true, text: `已在 bundle 层（${pkg}）`, activated: true }
}