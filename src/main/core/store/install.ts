/**
 * Installing plugins into the store and linking them into profiles. A download
 * is staged into a per-plugin mini pnpm project, hoisted to
 * `archive/<name>/<version>/`, and a profile's `link:` dependency then points at
 * that versioned copy (with bundle-layer reconcile for bundle-declaring plugins).
 */
import { mkdtempSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import AdmZip from 'adm-zip'
import { PNPM_WORKSPACE_YAML, runPnpm, type PnpmResult } from '../dsh/pnpm.ts'
import { logger } from '../shared/logger.ts'
import {
  archivedPluginNames, initStore, latestStoreVersion, pluginVersionDir, readVersion, stashLeaf, storeTrashDir,
  storeVersions, versionStagingDir, versionsRoot, type ProfileManifestShape,
} from './layout.ts'
import { bindingOf, devDirKey } from './binding.ts'
import { listDevPlugins } from './dev.ts'
import { readPluginSourceSnapshot, recordPluginSource, sourceKindOf } from './sources.ts'
import { registryEntryFor } from './registry.ts'
import { installNameFor } from './git-source.ts'
import { diagnoseFailure, type AdviceKey, type FailureKind, type FailureReport } from './failure.ts'
import { pathIdentifierInvalid, versionInvalid } from '../profile/name-guard.ts'
import { migrateLegacyStore } from './migration.ts'
import { isLegacyPkg } from './uninstall.ts'
import { listBundleSubdepNames } from './subdeps.ts'

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

/** Write the hoisted pnpm workspace into a project, unless it already has one.
 * Applied to the staging project BEFORE the add (that is what makes the archive
 * come out hoisted) and, by `repairArchiveLinks`, to archives that predate it. */
function writeHoistedWorkspace(verDir: string): boolean {
  const p = join(verDir, 'pnpm-workspace.yaml')
  if (existsSync(p)) return false
  writeFileSync(p, PNPM_WORKSPACE_YAML)
  return true
}

/** Derive a package-name hint from a download source. Delegates to the shared
 * multi-forge parser (`git-source.ts`), so an npm spec, a `github:`/`gitlab:`/
 * `gitea:`/`gitee:` shorthand, a git URL on any host, or a `file:` path all
 * answer consistently. The hint is only a HINT: `installSource` re-reads the
 * real name from `node_modules` and reports a mismatch rather than trusting it. */
export function packageNameFromSource(source: string): string {
  return installNameFor(source) ?? 'plugin'
}

/** A pnpm command that must see the registry, not a cached packument.
 *
 * A version can be republished under the same number (a hotfix), but pnpm's
 * metadata cache keeps the old `dist.integrity`. A throwaway cache directory
 * makes this one command resolve from the registry; the store is separate and
 * content-addressed, so tarballs are still reused. Works for every scope — the
 * caller supplies the package names, nothing is hard-coded here. The directory
 * is removed once the child exits, including on cancel. */
async function runWithFreshCache(
  cwd: string, args: readonly string[], signal: AbortSignal | undefined, storeDir: string,
): Promise<PnpmResult> {
  const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-pnpm-cache-'))
  try {
    return await runPnpm(cwd, [...args, `--config.cache-dir=${cacheDir}`], signal, { storeDir })
  } finally {
    try {
      rmSync(cacheDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup: a leftover temp cache must not fail an install.
    }
  }
}

/** The pnpm errors that mean a tarball no longer matches its lock/metadata. */
const INTEGRITY_FAILURE = /ERR_PNPM_TARBALL_INTEGRITY|integrity checksum failed|EINTEGRITY/i

/** Extract the package whose tarball failed the integrity check. pnpm prints the
 * tarball URL; the package is the segment(s) before the LAST `/-/` (the CNB
 * registry adds its own `/-/packages` prefix, so the first marker is not the
 * package boundary). Returns undefined when the output has no usable URL. */
export function packageFromIntegrityLog(text: string): string | undefined {
  const url = /https?:\/\/\S+?\.tgz/.exec(text)?.[0]
  if (url === undefined) return undefined
  const marker = url.lastIndexOf('/-/')
  if (marker < 0) return undefined
  const segments = url.slice(0, marker).split('/').filter((segment) => segment !== '')
  const last = segments[segments.length - 1]
  if (last === undefined) return undefined
  const previous = segments[segments.length - 2]
  return previous?.startsWith('@') === true ? `${previous}/${last}` : last
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

/** The package names a staging project actually installed, most-likely-first.
 * Reads `node_modules` (one level, plus `@scope/name` inside a scope dir) and
 * keeps the ones that look like the plugin itself: a package with a `.dsh`
 * manifest key or a name matching the install hint. Used only to explain a
 * mismatch, so it is deliberately forgiving — an empty list just means the
 * generic message is shown. */
function installedPackageNames(staging: string): string[] {
  const mods = join(staging, 'node_modules')
  if (!existsSync(mods)) return []
  const out: string[] = []
  const consider = (dir: string, name: string): void => {
    // Peer/host packages are what a plugin DEPENDS on, never what it installs as.
    if (name === '.pnpm' || name === '.bin' || name.startsWith('@deepseek-ai/')) return
    if (!existsSync(join(dir, 'package.json'))) return
    out.push(name)
  }
  for (const entry of readdirSync(mods, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      for (const inner of readdirSync(join(mods, entry.name), { withFileTypes: true })) {
        if (inner.isDirectory()) consider(join(mods, entry.name, inner.name), `${entry.name}/${inner.name}`)
      }
      continue
    }
    consider(join(mods, entry.name), entry.name)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/** A store install's outcome. `version` is the version actually ARCHIVED by this
 * call, which is not always the one a caller would re-derive afterwards:
 * `latestStoreVersion` answers "highest in store", so asking it which build a
 * snapshot just produced silently picks a different one when a higher version is
 * already archived. Optional only so existing `PnpmResult` callers keep working.
 *
 * `failure` is present on every failed result: the classified reason plus the
 * evidence it was read from. `text` stays the human-facing message, but a caller
 * that shows a failure to a person should prefer `failure` — it carries the kind
 * (so the UI can suggest a fix) and keeps `text` short instead of dumping a log. */
export type InstallResult = PnpmResult & {
  version?: string
  failure?: FailureReport
  /** The complete pnpm output of the attempt, retained on failure/cancel. */
  log?: string
}

/** Build a failed `InstallResult` from a pre-known cause (a guard clause). The
 * guards below reject before pnpm runs, so there is no log to read — the reason
 * is the message, and the advice is whatever that reason implies. */
function refusal(text: string, kind: FailureKind, advice: AdviceKey[], params?: Record<string, string>): InstallResult {
  return {
    ok: false,
    text,
    failure: {
      kind,
      headlineKey: text,
      headline: text,
      advice,
      evidence: [text],
      ...(params !== undefined ? { params } : {}),
    },
  }
}

/** Shared download path: build the source into a staging project, read the real
 * version, then hoist the whole project to `archive/<name>/<version>/`.
 *
 * `replace` decides what an already-archived version means. Left false (the
 * default), re-adding a version that is already present is a no-op — the right
 * answer for a re-download. Set true by a dev snapshot, where the source tree
 * moved on but its `version` did not, and keeping the older archive would report
 * success while storing the previous state. */
export async function installSource(
  storeDir: string, name: string, source: string, signal?: AbortSignal, opts?: { replace?: boolean; snapshot?: boolean; force?: boolean },
): Promise<InstallResult> {
  if (name.trim() === '') return refusal('未能确定插件包名', 'name-mismatch', ['checkPackageJson'])
  // The name becomes an `archive/<name>/` path segment; refuse anything that
  // could escape the store tree (`..`, `\`, drive/absolute, `//`). Deliberately
  // looser than npm's name rules so local/legacy package names (uppercase, …)
  // still install.
  if (pathIdentifierInvalid(name)) return refusal(`插件包名不合法：${name}`, 'name-mismatch', ['checkPackageJson'])
  // A source starting with `-` would be parsed by pnpm as a flag, not a package.
  if (source.trim().startsWith('-')) return refusal(`插件来源不合法：${source}`, 'not-a-package', ['checkName'])
  // Never add a version alongside a legacy flat package for the same plugin —
  // absorb old packages into the versioned layout first (and retarget any
  // profiles that link into a moved package).
  await migrateLegacyStore(storeDir)
  initStore(storeDir)
  const staging = versionStagingDir(storeDir, name)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  initStore(staging) // a minimal project for `pnpm add` to resolve into
  // The staging project must describe ITSELF before anything is added into it.
  // Without this yaml pnpm uses its defaults, and both defaults are wrong here:
  // `autoInstallPeers` would resolve the package's host-service peers
  // (`@deepseek-ai/dsh-*`, cordis) from the REGISTRY, so the archive would carry a
  // private copy of the host stack pinned to whatever npm had that day — resolved
  // from the archive tree instead of from the profile, and stale the moment the
  // host moves on. And `nodeLinker: isolated` hides an aggregate bundle's
  // sub-packages behind `.pnpm/`, leaving them invisible until a later re-link.
  // The yaml also stops a staging project with no workspace of its own from
  // silently adopting an ANCESTOR pnpm workspace and installing into that.
  // Writing it here (rather than after the rename) means the archive is already
  // the right shape when it is first built; the post-rename hoist is gone.
  writeHoistedWorkspace(staging)
  // A registry version can be hotfixed in place. Resolve this add with a
  // throwaway metadata cache so EVERY package in the graph (including transitive
  // deps of any scope) is read from the registry, not from a stale packument.
  const isRegistry = sourceKindOf(source) === 'npm'
  const addArgs = ['add', source, '--fetch-retries=3', '--fetch-retry-maxtimeout=60000']
  let result = isRegistry
    ? await runWithFreshCache(staging, addArgs, signal, storeDir)
    : await runPnpm(staging, addArgs, signal, { storeDir })
  if (!result.ok && result.aborted !== true && isRegistry && INTEGRITY_FAILURE.test(result.text)) {
    // The metadata and tarball disagreed (registry changed mid-add, or a proxy
    // served a stale packument). A second fresh cache is cheap; retry once.
    logger.warn(`plugin store: integrity failure while adding ${name}; retrying with a fresh metadata cache`)
    result = await runWithFreshCache(staging, addArgs, signal, storeDir)
  }
  // A user cancel: drop the half-downloaded staging dir and surface it as a
  // cancel, not a failure — the download task manager treats it as cancelled.
  // The log is still carried: a cancelled session can be opened in the detail
  // view, and knowing how far it got is the useful part.
  if (result.aborted === true) {
    rmSync(staging, { recursive: true, force: true })
    return {
      ok: false, aborted: true, text: 'cancelled',
      ...(result.command !== undefined ? { command: result.command } : {}),
      ...(result.code !== undefined ? { code: result.code } : {}),
      ...(result.durMs !== undefined ? { durMs: result.durMs } : {}),
      log: result.text,
      failure: diagnoseFailure({ log: result.text, source, name, aborted: true }),
    }
  }
  if (!result.ok) {
    rmSync(staging, { recursive: true, force: true })
    // The log is classified into a cause plus the evidence it was read from. The
    // raw output travels with it, untruncated: the detail view shows the whole
    // thing, and a tail-only copy cannot answer "why".
    return {
      ...result,
      log: result.text,
      failure: diagnoseFailure({
        log: result.text, source, name,
        ...(result.code !== undefined ? { code: result.code } : {}),
      }),
    }
  }
  const version = readVersion(join(staging, 'node_modules', name))
  if (version === undefined) {
    // pnpm may have reported success while the package never landed (e.g. a
    // resolution failure whose `added 0` slipped the fallible check above).
    //
    // The guessed name is the usual cause when it does not match the guess: a
    // repo whose `package.json` declares a scoped/different name installs fine
    // under THAT name, so the check above looks in the wrong directory. Name the
    // real package(s) pnpm did install — the user never typed a package name, so
    // "package name mismatch" alone explains nothing.
    const landed = installedPackageNames(staging)
    const log = result.text
    rmSync(staging, { recursive: true, force: true })
    const hint = landed.length === 0
      ? `包名不匹配，或依赖解析失败`
      : `来源实际安装的包名是 ${landed.slice(0, 3).join(' / ')}，与按来源推测的 ${name} 不一致`
    return {
      ...result,
      ok: false,
      text: `未在 node_modules 中找到 ${name}（${hint}）`,
      log,
      failure: diagnoseFailure({ log, source, name, hint }),
    }
  }
  // The version becomes an `archive/<name>/<version>/` path segment AND a `.trash`
  // leaf name. A registry source is semver-enforced by the registry, but a
  // `github:` / local zip / folder package declares its own version — untrusted
  // input. `..` would build both paths outside the store: with replace=false the
  // staging project is moved out there and `pnpm install` runs in it; with
  // replace=true that directory is renamed aside and deleted recursively. The
  // same guard the IPC boundary applies, applied where the path is actually built.
  if (versionInvalid(version)) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, text: `插件包声明的版本号不可用：${version}`, failure: refusal(`插件包声明的版本号不可用：${version}`, 'version', ['checkPackageJson']).failure }
  }
  const dest = pluginVersionDir(storeDir, name, version)
  if (existsSync(dest) && opts?.replace !== true) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: true, text: `已在该版本（${name}@${version}）`, version }
  }
  if (existsSync(dest)) {
    // A local snapshot under a released version number would replace the
    // published copy with something that exists only on this machine - after
    // which "I have 1.0.0 installed" no longer says which 1.0.0 it is. Refuse
    // by default; a version bump is the honest way out, and `force` covers the
    // developer who really does mean to overwrite their own archive.
    if (opts?.snapshot === true && opts.force !== true && readPluginSourceSnapshot(storeDir, name, version) === false) {
      rmSync(staging, { recursive: true, force: true })
      return {
        ok: false,
        text: `${name}@${version} 已经是发布版本，本地快照会用本地构建顶替它。改一个版本号，或确认后强制覆盖。`,
      }
    }
    // A replaced version is only set aside once the new one is BUILT: the staging
    // project above is the replacement, so an archive is never absent because a
    // rebuild failed. Until this point the old version was still serving profiles.
    // The stash lives OUTSIDE `archive/` because `storeVersions` enumerates every
    // dir under `archive/<name>/` that holds a package body — a sibling would be
    // read as a version of its own. It is one flat leaf, removed on success, so
    // nothing accumulates.
    const stash = join(storeTrashDir(storeDir), stashLeaf(name, version))
    mkdirSync(storeTrashDir(storeDir), { recursive: true })
    rmSync(stash, { recursive: true, force: true })
    try {
      renameSync(dest, stash)
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      return { ok: false, text: `无法替换已有版本：${error instanceof Error ? error.message : String(error)}` }
    }
    mkdirSync(dirname(dest), { recursive: true })
    try {
      renameSync(staging, dest)
    } catch (error) {
      // Put the previous archive back rather than leaving a hole in the store.
      renameSync(stash, dest)
      return { ok: false, text: `归档失败：${error instanceof Error ? error.message : String(error)}` }
    }
    rmSync(stash, { recursive: true, force: true })
    await relinkVersion(dest, join(dest, 'node_modules', name), storeDir)
    recordPluginSource(storeDir, name, version, sourceKindOf(source), source, registryEntryFor(name)?.id, opts?.snapshot === true)
    logger.info(`plugin store replaced: ${name}@${version} (${source})`)
    return { ok: true, text: `已替换归档 ${name}@${version}`, version }
  }
  mkdirSync(dirname(dest), { recursive: true })
  try {
    renameSync(staging, dest)
  } catch (error) {
    return { ok: false, text: `归档失败：${error instanceof Error ? error.message : String(error)}` }
  }
  // Moving `.staging` → version dir dangles pnpm's absolute top-level links (they
  // name the now-gone `.staging`); let pnpm rewire them to this version's goods.
  await relinkVersion(dest, join(dest, 'node_modules', name), storeDir)
  recordPluginSource(storeDir, name, version, sourceKindOf(source), source, registryEntryFor(name)?.id, opts?.snapshot === true)
  logger.info(`plugin store add: ${name}@${version} (${source})`)
  return { ok: true, text: `已下载 ${name}@${version}`, version }
}

/**
 * Rewire a version that was JUST archived in place: one `pnpm install`, which is
 * enough because everything it needs is already in the store this call used. The
 * body is verified rather than trusted — a stale pnpm lock can mark the install
 * "up to date" while a dangling top-level link stays broken (pnpm trusts
 * `.modules.yaml` and never re-checks the junction target). Only a verified
 * failure escalates, to the repair ladder.
 */
async function relinkVersion(verDir: string, pkgDir: string, storeDir: string): Promise<boolean> {
  const bodyOk = (): boolean => existsSync(join(pkgDir, 'package.json'))
  const once = await runPnpm(verDir, ['install', '--config.confirmModulesPurge=false'], undefined, { storeDir })
  if (once.ok && bodyOk()) return true
  logger.warn(`plugin store: relink left ${verDir} unusable — falling back to the repair ladder`)
  return reinstallVersion(verDir, pkgDir, storeDir)
}

/**
 * The REPAIR ladder: offline, then online, then `--force`. This is for archives
 * that may predate the current install method or were left broken by an
 * interrupted download, so it escalates instead of trusting one attempt. It is
 * deliberately NOT the fresh-add path: a version built a moment ago needs one
 * install, and paying three — two of them networked — for every new archive is
 * what made a normal download feel slow.
 */
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
    // `basename` guarantees a single path segment, but not a SAFE one: a file
    // named `...zip` strips its `.zip` suffix down to `..`, and
    // `join(storeDir, '.import', '..')` IS the store — which the `rmSync` below
    // would then clear recursively, taking every archived plugin with it. Same
    // guard as a package-declared name, applied where the segment is built.
    const stem = basename(path).replace(/\.zip$/i, '')
    if (stem !== '' && pathIdentifierInvalid(stem)) {
      return { ok: false, text: `zip 文件名不可用：${basename(path)}` }
    }
    const dest = join(storeDir, '.import', stem || 'plugin')
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

/** Specs that are not registry versions: their "update" is a local/git operation
 * and naming them would make pnpm resolve a package that is not on the registry. */
const NON_REGISTRY_SPEC = /^(?:file|link|workspace|portal|catalog|git\+|github|gitlab|gitea|gitee|https?):/i

/** Refresh the lock entries for an archived plugin's direct registry deps.
 *
 * A registry version can be republished under the same number, but the profile's
 * lock keeps the old integrity; `pnpm install` then replays the cached old bytes
 * (or fails `ERR_PNPM_TARBALL_INTEGRITY`). The dependency NAMES come from the
 * plugin's own manifest, so this works for any package and any scope — there is
 * no hard-coded registry or scope here. `pnpm update --lockfile-only` re-resolves
 * those names (an exact spec keeps its version; a range may move within it), and
 * the throwaway metadata cache makes the update read the registry rather than a
 * stale packument. */
async function refreshPluginDependencies(dir: string, pkgDir: string, storeDir: string): Promise<boolean> {
  let manifest: { dependencies?: Record<string, string> }
  try {
    manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as typeof manifest
  } catch {
    return false
  }
  const names = Object.entries(manifest.dependencies ?? {})
    .filter(([, spec]) => !NON_REGISTRY_SPEC.test(spec.trim()) && !spec.trim().startsWith('npm:'))
    .map(([name]) => name)
  if (names.length === 0) return false
  const update = await runWithFreshCache(dir, ['update', ...names, '--lockfile-only'], undefined, storeDir)
  if (!update.ok) {
    logger.warn(`plugin install: could not refresh the plugin's dependency lock entries: ${update.text}`)
    return false
  }
  return true
}

/** Refresh one package's lock entry, whatever its scope. This is the general
 * fallback for a hotfixed transitive dependency: `pnpm update` re-resolves the
 * named package in place (the exact version is kept; only its resolution
 * changes), and the throwaway metadata cache makes it read the registry rather
 * than a stale packument. */
async function refreshLockPackage(dir: string, name: string, storeDir: string): Promise<boolean> {
  const update = await runWithFreshCache(dir, ['update', name, '--lockfile-only'], undefined, storeDir)
  if (!update.ok) {
    logger.warn(`plugin install: could not refresh the lock entry for ${name}: ${update.text}`)
    return false
  }
  return true
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
  profilesRoot: string, profile: string, pkg: string, storeDir: string,
  opts: { version?: string; force?: boolean } = {},
): Promise<{ ok: boolean; text: string; activated: boolean; needsConfirm?: 'replaces-dev-link' }> {
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
  const dir = join(profilesRoot, profile)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return { ok: false, text: `profile "${profile}" 不存在`, activated: false }

  const originalManifestText = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(originalManifestText) as ProfileManifestShape
  // Switching a profile off a dev link is the one thing this function can do
  // that the user did not ask for: the link disappears from the manifest and the
  // working copy stops being loaded. Ask first - the dev registration survives
  // either way, so a confirmation is all it takes to make this reversible in
  // practice as well as in theory.
  if (opts.force !== true) {
    const devDirs = new Set(listDevPlugins().map(dev => devDirKey(dev.dir)))
    const existing = (manifest.dependencies as Record<string, string> | undefined)?.[pkg]
    if (bindingOf(existing, devDirs) === 'dev') {
      return {
        ok: false,
        text: `${pkg} 在这个 profile 里是本地链接。安装库中版本会替换它（开发插件本身不会被删除）。`,
        activated: false,
        needsConfirm: 'replaces-dev-link',
      }
    }
  }
  /** Put the manifest back exactly as it was.
   *
   * The profile's own state is written BEFORE the install that makes it true, and
   * this is the one place the launcher edits a profile for a reason the user did
   * not ask for directly. The archive path has had stash/restore discipline all
   * along; the manifest had none, so a failed install left a dependency on a
   * package that is not there — a profile that no longer installs cleanly and says
   * nothing about why. (The file is required here — the guard above refuses a
   * profile without one — so restoring the text is the whole of it.) */
  const restoreManifest = (): void => {
    try {
      writeFileSync(manifestPath, originalManifestText)
      logger.warn('plugin install: restored the profile manifest', { profile, pkg })
    } catch (error) {
      logger.error('plugin install: could not restore the profile manifest', {
        profile, pkg, error: error instanceof Error ? error.message : String(error),
      })
    }
  }
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
  try {
    if (manifestChanged) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

    // A hotfixed dependency changes dist.integrity under the same version; refresh
    // this plugin's direct registry deps so the install does not replay the old
    // lock resolution. The list comes from the plugin's manifest (any scope).
    await refreshPluginDependencies(dir, pkgDir, storeDir)
    let install = await runPnpm(dir, ['install', '--config.confirmModulesPurge=false'], undefined, { storeDir })
    if (!install.ok && INTEGRITY_FAILURE.test(install.text)) {
      // The pre-install refresh is limited to the plugin's direct deps. For a
      // transitive package (or an unexpected failure), take the package named by
      // the failing tarball URL and refresh just that entry.
      const failed = packageFromIntegrityLog(install.text)
      const refreshed = failed === undefined
        ? await refreshPluginDependencies(dir, pkgDir, storeDir)
        : await refreshLockPackage(dir, failed, storeDir)
      if (refreshed) {
        install = await runPnpm(dir, ['install', '--config.confirmModulesPurge=false'], undefined, { storeDir })
      }
    }
    if (!install.ok) {
      restoreManifest()
      logger.warn('plugin install into profile failed', { profile, pkg, text: install.text })
      return { ok: false, text: `pnpm install 失败：${install.text}（profile 清单已恢复原样）`, activated: false }
    }

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
  } catch (error) {
    // A write that failed partway, or the bundle-layer write at the end: either way
    // the manifest is not what the caller promised, so it goes back to what the
    // user had. The plugin body may already sit in the profile's node_modules,
    // where it is inert without the dependency line pointing at it.
    restoreManifest()
    const text = error instanceof Error ? error.message : String(error)
    logger.warn('plugin install into profile threw', { profile, pkg, text })
    return { ok: false, text: `安装失败：${text}（profile 清单已恢复原样）`, activated: false }
  }
}
