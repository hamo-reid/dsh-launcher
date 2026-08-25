/**
 * Plugin store: a configurable directory managed by pnpm. `pnpm add` installs
 * npm-package or git sources as dependencies; `pnpm remove` uninstalls.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, normalize } from 'node:path'
import AdmZip from 'adm-zip'
import { runPnpm, type PnpmResult } from './pnpm.ts'
import { logger } from './logger.ts'
import { profilesDir } from './home.ts'
import type { InstalledOverviewRow, PluginSource, PluginUsagePoint } from '../../shared/types.ts'
import { dshScopes, type DshScope } from './appState.ts'

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

// ── multi-version layout ────────────────────────────────────────────────────
//
// The store keeps every downloaded plugin version in its own self-contained
// mini pnpm project under `archive/<name>/<version>/` (each holds its own
// package.json + resolved node_modules). The same plugin can therefore hold
// many versions at once; `installIntoProfile` links a profile to one specific
// version's package. A staging dir per plugin holds an in-flight download.
// (`archive/` is deliberately NOT named `archive/` — the dsh version
// repository already lives at <userData>/dsh/versions/, and the two must not
// collide when a user points the plugin store at a dsh-related directory.)
//
//   <storeDir>/archive/<name>/.staging/     in-flight download (mini pnpm project)
//   <storeDir>/archive/<name>/<version>/    one archived version, self-contained

/** Root of the versioned plugin archive (`archive/` sub-folder of the store). */
function versionsRoot(storeDir: string): string {
  return join(storeDir, 'archive')
}

/** Where a specific plugin lives in the versioned layout. `name` carries the
 * real npm name (`@scope/name`), so `path.join` expands a scoped package into a
 * multi-level dir — matching pnpm's nested `node_modules/@scope/name` layout, so
 * the archive path and the resolved package body always line up. */
export function pluginVersionDir(storeDir: string, name: string, version: string): string {
  return join(versionsRoot(storeDir), name, version)
}

/** The staging project a download is built into before being hoisted to its
 * version-named directory. */
function versionStagingDir(storeDir: string, name: string): string {
  return join(versionsRoot(storeDir), name, '.staging')
}

/** Enumerate every archived plugin's real npm name. Regular packages sit directly
 * under `archive/<name>`; scoped packages start with `@` and nest one level
 * deeper as `archive/@scope/<name>`. (Legacy flattened `@scope_name` leftovers
 * read back as bogus names here, but their node_modules lookup fails below, so
 * they never surface — ignored by design.) */
function archivedPluginNames(storeDir: string): string[] {
  const vRoot = versionsRoot(storeDir)
  if (!existsSync(vRoot)) return []
  const names: string[] = []
  for (const e of readdirSync(vRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === '.staging') continue
    if (e.name.startsWith('@')) {
      const scopeDir = join(vRoot, e.name)
      for (const s of readdirSync(scopeDir, { withFileTypes: true }))
        if (s.isDirectory() && s.name !== '.staging') names.push(`${e.name}/${s.name}`)
    } else {
      names.push(e.name)
    }
  }
  return names
}

/** Confirmed archived versions of one plugin (dirs with a resolved package). */
export function storeVersions(storeDir: string, name: string): string[] {
  const root = join(versionsRoot(storeDir), name)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== '.staging')
    .map(e => e.name)
    .filter(v => existsSync(join(root, v, 'node_modules', name, 'package.json')))
    .sort()
}

/** Highest archived version of a plugin, or `undefined` when none is present.
 * Multi-version aware: newer versions rank above older ones by string compare. */
export function latestStoreVersion(storeDir: string, name: string): string | undefined {
  const vs = storeVersions(storeDir, name)
  return vs.length === 0 ? undefined : vs[vs.length - 1]
}

/** Version of a package currently in the store, or `undefined`. In a
 * multi-version store this reports the highest archived version, so a caller
 * checking "is an acceptable version already downloaded" keeps working. */
export function installedStoreVersion(storeDir: string, name: string): string | undefined {
  if (storeDir === '') return undefined
  return latestStoreVersion(storeDir, name) ?? readVersion(join(storeDir, 'node_modules', name))
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

// ── archived-version origin tracking ────────────────────────────────────────

/** Classify a download source into the store's origin kind. A `github:` spec is a
 * GitHub-source install; `file:` is a locally-added plugin; anything else (a bare
 * name, `name@ver`, `@scope/pk@ver`) is an npm install. */
function sourceKindOf(source: string): PluginSource {
  const s = source.trim()
  if (s.startsWith('github:')) return 'github'
  if (s.startsWith('file:')) return 'local'
  return 'npm'
}

/** Cornerstone: the recorded origins live in their own sidecar file, NOT the
 * store's pnpm manifest — `pnpm add`/`remove` and `migrateLegacyStore` rewrite
 * that manifest and would silently drop the tracking. */
function sourcesFile(storeDir: string): string { return join(storeDir, '.pm-sources.json') }

/** Archived-version → origin map, keyed `name@version`. */
function readPluginSources(storeDir: string): Record<string, PluginSource> {
  try {
    const v: unknown = JSON.parse(readFileSync(sourcesFile(storeDir), 'utf8'))
    return v !== null && typeof v === 'object' ? (v as Record<string, PluginSource>) : {}
  } catch {
    return {}
  }
}

/** Record the origin of one archived version. Idempotent per version. */
function recordPluginSource(storeDir: string, name: string, version: string, kind: PluginSource): void {
  const data = readPluginSources(storeDir)
  data[`${name}@${version}`] = kind
  writeFileSync(sourcesFile(storeDir), JSON.stringify(data, null, 2) + '\n')
}

/** List every archived plugin version in the store, UNION the legacy top-level
 * layout. The same plugin may appear multiple times with different versions
 * (the multi-version layout). Leftover legacy packages (still at the flat
 * `node_modules/` + manifest deps of an upgraded store) are included too, so a
 * migrated store shows nothing as missing. */
export function listPlugins(dir: string): { name: string; version: string }[] {
  if (dir === '') return [] // no store configured — never fall back to cwd
  const seen = new Set<string>()
  const out: { name: string; version: string }[] = []
  const push = (name: string, version: string): void => {
    const key = `${name} ${version}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ name, version })
  }
  // Archived versions, keyed by real npm name. `storeVersions` resolves the
  // package body against `node_modules/<name>` (scoped packages nest), so only
  // versions whose resolved package is actually present count as archived.
  for (const name of archivedPluginNames(dir)) {
    for (const version of storeVersions(dir, name)) push(name, version)
  }
  for (const p of legacyListPlugins(dir)) push(p.name, p.version)
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0))
}

/** Read the legacy store layout (a single pnpm project at the store root). */
function legacyListPlugins(dir: string): { name: string; version: string }[] {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StoreManifest
  return Object.entries(manifest.dependencies ?? {}).map(([name, version]) => ({ name, version }))
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

/**
 * Hoist any plugin left in the legacy flat layout (`node_modules/<name>` +
 * manifest deps) into the versioned layout, once, before the first store write.
 * A package's directory is moved into `archive/<name>/<version>/node_modules/`
 * — its dependencies stay resolvable because Node walks up the parent dirs and
 * finds the (still present) top-level node_modules. The manifest's hoisted deps
 * are then cleared so a plugin never exists in both layouts. Idempotent: a name
 * that already has entries under `archive/` is left untouched.
 */
/** Whether the store still holds legacy flat packages awaiting the one-time
 * migration (top-level node_modules entries not yet absorbed into versions). */
export function needsStoreMigration(storeDir: string): boolean {
  if (storeDir === '') return false
  const manifestPath = join(storeDir, 'package.json')
  if (!existsSync(manifestPath)) return false
  let manifest: StoreManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StoreManifest
  } catch {
    return false
  }
  return Object.keys(manifest.dependencies ?? {}).some(name =>
    existsSync(join(storeDir, 'node_modules', name, 'package.json')) && storeVersions(storeDir, name).length === 0)
}

/** Explicitly run the one-time legacy → versioned migration once the user has
 * consented in the UI. A no-op once the store is already versioned. */
export async function migrateStore(storeDir: string): Promise<void> {
  await migrateLegacyStore(storeDir)
}

async function migrateLegacyStore(storeDir: string): Promise<void> {
  if (storeDir === '') return
  const manifestPath = join(storeDir, 'package.json')
  if (!existsSync(manifestPath)) return
  let manifest: StoreManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StoreManifest
  } catch {
    return
  }
  const deps = manifest.dependencies ?? {}
  const moves: { old: string; next: string }[] = []
  const archived: string[] = []
  for (const name of Object.keys(deps)) {
    const src = join(storeDir, 'node_modules', name)
    if (!existsSync(join(src, 'package.json'))) continue
    if (storeVersions(storeDir, name).length > 0) {
      // Already present in the archive — no rebuild needed, just retarget links.
      archived.push(name)
      rmSync(src, { recursive: true, force: true })
      logger.info(`store migration: dropped legacy ${name} (already in archive)`)
      continue
    }
    const version = readVersion(src)
    if (version === undefined) continue
    const verDir = pluginVersionDir(storeDir, name, version)
    const archivedTarget = join(verDir, 'node_modules', name)
    if (!existsSync(join(archivedTarget, 'package.json'))) {
      // Copy the package SOURCE (NOT its resolved node_modules) into the archive,
      // then let pnpm re-resolve so each version is self-contained again.
      const srcDir = join(verDir, '.src')
      rmSync(srcDir, { recursive: true, force: true })
      logger.info(`store migration: staging source of ${name}@${version} into archive/`)
      try {
        mkdirSync(verDir, { recursive: true })
        cpSync(src, srcDir, { recursive: true, filter: p => basename(p) !== 'node_modules' })
      } catch (error) {
        logger.warn(`store migration: could not stage ${name}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      initStore(verDir)
      // Reuse what the old library already downloaded: pnpm's global content-
      // addressable store holds those deps, so an OFFLINE add hard-links them
      // back fast instead of re-downloading and re-copying node_modules. Only
      // fall back to the network when the offline cache misses.
      logger.info(`store migration: reinstalling ${name}@${version} via pnpm (offline)`)
      const offline = await runPnpm(verDir, ['add', `file:${srcDir}`, '--offline', '--prefer-offline'])
      if (!offline.ok || !existsSync(join(archivedTarget, 'package.json'))) {
        logger.warn(`store migration: offline reinstall failed for ${name}, retrying online: ${offline.text}`)
        const online = await runPnpm(verDir, ['add', `file:${srcDir}`, '--fetch-retries=3', '--fetch-retry-maxtimeout=60000'])
        if (!online.ok) {
          logger.warn(`store migration: pnpm reinstall failed for ${name}: ${online.text}`)
          continue
        }
        if (!existsSync(join(archivedTarget, 'package.json'))) {
          logger.warn(`store migration: ${name} did not land in the archive after pnpm add`)
          continue
        }
      }
    }
    moves.push({ old: src, next: archivedTarget })
    archived.push(name)
    rmSync(src, { recursive: true, force: true })
    logger.info(`store migration: archived ${name}@${version}`)
  }
  if (archived.length === 0) return
  for (const name of archived) delete deps[name]
  writeFileSync(manifestPath, JSON.stringify({ name: 'plugin-store', private: true, dependencies: deps }, null, 2) + '\n')
  logger.info(`store migration: completed ${archived.length} plugin(s) into archive/`)
  // Profiles that `link:` into a now-removed top-level path must point at the new
  // archived copy, else their link would go dangling once the dir is gone.
  await rewriteProfileLinks(storeDir, moves)
}

/**
 * Rewrite every profile dependency whose `link:` target was a moved top-level
 * package dir, then re-run pnpm install on the affected profiles so their
 * node_modules link resolves to the new versioned copy. Safe no-op when there
 * are no profiles (or no app-state yet).
 */
async function rewriteProfileLinks(storeDir: string, moves: { old: string; next: string }[]): Promise<void> {
  const redirect = new Map(moves.map(m => [normalize(m.old), normalize(m.next)]))
  logger.info(`store migration: rewriteProfileLinks scanning (${moves.length} moved)`)
  let scopes: DshScope[] = []
  try {
    scopes = dshScopes()
  } catch {
    return // no persisted app state in some environments — nothing to rewrite
  }
  const affected: string[] = []
  for (const dsh of scopes) {
    const base = dsh.profilesDir ?? join(dsh.home, 'profiles')
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const profileDir = join(base, entry.name)
      const mp = join(profileDir, 'package.json')
      if (!existsSync(mp)) continue
      let m: ProfileManifestShape
      try {
        m = JSON.parse(readFileSync(mp, 'utf8'))
      } catch {
        continue
      }
      const deps = m.dependencies ?? {}
      let changed = false
      for (const key of Object.keys(deps)) {
        const spec = deps[key]
        if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
        const target = normalize(spec.slice(5))
        const next = redirect.get(target)
        if (next !== undefined) {
          deps[key] = `link:${next}`
          changed = true
        }
      }
      if (changed) {
        m.dependencies = deps
        writeFileSync(mp, JSON.stringify(m, null, 2) + '\n')
        affected.push(profileDir)
      }
    }
  }
  logger.info(`store migration: rewriteProfileLinks found ${affected.length} affected profile(s)`)
  for (const pdir of affected) {
    const r = await runPnpm(pdir, ['install'])
    if (!r.ok) logger.warn(`store migration: profile reinstall failed ${pdir}: ${r.text}`)
  }
  logger.info('store migration: rewriteProfileLinks done')
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
  const result = await runPnpm(staging, ['add', source, '--fetch-retries=3', '--fetch-retry-maxtimeout=60000'], signal)
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
  // Moving `.staging` → version dir dangles pnpm's absolute top-level links (they
  // name the now-gone `.staging`); let pnpm rewire them to this version's goods.
  await reinstallVersion(dest)
  recordPluginSource(storeDir, name, version, sourceKindOf(source))
  logger.info(`plugin store add: ${name}@${version} (${source})`)
  return { ok: true, text: `已下载 ${name}@${version}` }
}

/** Rewire an archived version's top-level node_modules links after the staging
 * dir was moved to its final location. pnpm writes those top-level links as
 * absolute targets naming `.staging`, so the rename invalidates them; a reinstall
 * rebuilds them against this version's own `.pnpm` goods. Needs
 * `confirmModulesPurge=false`: pnpm sees a moved project as needing a full
 * rebuild, and would otherwise wait on an interactive prompt in a non-CI child. */
async function reinstallVersion(verDir: string): Promise<boolean> {
  const offline = await runPnpm(verDir, ['install', '--offline', '--prefer-offline', '--config.confirmModulesPurge=false'])
  if (offline.ok) return true
  const online = await runPnpm(verDir, ['install', '--config.confirmModulesPurge=false', '--fetch-retries=3', '--fetch-retry-maxtimeout=60000'])
  if (online.ok) return true
  logger.warn(`plugin store: failed to rewire links in ${verDir}: ${offline.text || online.text}`)
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
      if (existsSync(join(verDir, 'node_modules', name, 'package.json'))) continue
      logger.info(`plugin store: rewiring broken archive ${name}@${v.name}`)
      await reinstallVersion(verDir)
    }
  }
}

/** Prune an emptied archive scope dir (`archive/@scope`) left behind when its
 * last package (or last version) was just removed — a scoped removal must not
 * strand an empty `@scope` shell. Walks up multi-level scopes (`@a/b/…`) and
 * stops at the first non-`@` segment (the `archive/` root) or a non-empty dir. */
function pruneEmptyScopes(from: string): void {
  let cur = from
  while (basename(cur).startsWith('@')) {
    const entries = existsSync(cur) ? readdirSync(cur).filter(e => e !== '.staging') : []
    if (entries.length > 0) break // still holds siblings — keep it
    if (existsSync(cur)) rmSync(cur, { recursive: true, force: true })
    cur = dirname(cur)
  }
}

/**
 * Remove every link a plugin has into a profile, across all dsh scopes: drop the
 * `link:`/`file:` dependency, drop it from the bundle layer if it declared
 * `dsh.bundle`, then `pnpm install` so the profile's node_modules junction to
 * the store archive is unlinked. This is the prerequisite to deleting the store
 * archive — an active profile `link:` keeps the archived dir occupied on Windows
 * (and keeps the plugin surfacing in the overview), so a "full uninstall" must
 * detach the profiles first. Returns the affected usage points.
 */
export async function removePluginFromProfiles(dshes: DshScope[], pkg: string): Promise<PluginUsagePoint[]> {
  const affected: PluginUsagePoint[] = []
  for (const dsh of dshes) {
    const dir = dsh.profilesDir ?? join(dsh.home, 'profiles')
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const profileDirPath = join(dir, entry.name)
      const manifestPath = join(profileDirPath, 'package.json')
      if (!existsSync(manifestPath)) continue
      let manifest: ProfileManifestShape
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch {
        continue
      }
      const spec = manifest.dependencies?.[pkg]
      const isLinked = typeof spec === 'string' && (spec.startsWith('link:') || spec.startsWith('file:'))
      const bundles = manifest.dsh?.profile?.bundles
      const inBundles = bundles !== undefined && bundles.includes(pkg)
      const nmPkg = join(profileDirPath, 'node_modules', pkg)
      // lstat-based existence: catches dangling junctions whose target is already
      // gone (existsSync would report false for those, yet the link still pins
      // the store archive and must be unlinked).
      let nmSt
      try { nmSt = lstatSync(nmPkg) } catch { /* absent */ }
      const nmHasIt = nmSt !== undefined
      // A profile counts as "using it" if it still declares the plugin OR its
      // node_modules holds a leftover entry. The latter alone keeps the store
      // archive occupied on Windows — even a manifest-cleared profile with a
      // stale junction must be detached so the archive can actually be removed.
      if (!isLinked && !inBundles && !nmHasIt) continue
      if (manifest.dependencies?.[pkg] !== undefined) delete manifest.dependencies[pkg]
      if (inBundles) {
        manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: bundles.filter(b => b !== pkg) } }
      }
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
      // PHYSICALLY remove the plugin's folder here. A leftover junction must be
      // unlinked directly (never recursed into), else it keeps pinning the store
      // archive. A real directory is deleted via deleteTreePhysical (symlink-safe).
      if (nmSt !== undefined) {
        // isSymbolicLink() is true for a Windows junction too, but a bare rmSync
        // on a junction throws ERR_FS_EISDIR — unlink (remove the link entry, do
        // not follow it) is the only reliable path for both.
        if (nmSt.isSymbolicLink()) unlinkSync(nmPkg)
        else deleteTreePhysical(nmPkg)
      }
      await runPnpm(profileDirPath, ['install'])
      affected.push({ dsh: dsh.name, dshVersion: dsh.version, profile: entry.name })
    }
  }
  return affected
}

/**
 * Recursively delete a directory tree reliably on Windows. pnpm archives are
 * full of symlinks/junctions and `fs.rmSync({recursive})` is unreliable on them —
 * it can exit cleanly yet leave directories behind (which is exactly how a
 * "physically deleted" plugin stays in the overview). We instead unlink every
 * symlink/junction FIRST (removing the link entry itself, never following it
 * into a target), then delete the remaining files/dirs. Deterministic.
 */
export function deleteTreePhysical(dir: string): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    rmSync(dir, { recursive: true, force: true })
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      // unlink the link itself (stop it from pinning the tree / following into a
      // target) — never recurse into what it points at. Must use unlinkSync, not
      // rmSync: a bare rmSync on a junction throws ERR_FS_EISDIR on Windows.
      unlinkSync(full)
    } else if (entry.isDirectory()) {
      deleteTreePhysical(full)
    } else {
      rmSync(full, { force: true })
    }
  }
  rmSync(dir, { recursive: true, force: true })
}

/** Uninstall a plugin from the store. Without `version` the whole plugin (every
 * archived version) is removed; with it, only that one archived version goes. */
export function removePlugin(dir: string, name: string, version?: string): PnpmResult {
  if (dir === '') return { ok: false, text: '未配置插件保存位置 —— 请在「设置」中指定' }
  const pRoot = join(versionsRoot(dir), name)
  if (version === undefined) {
    if (!existsSync(pRoot) && !isLegacyPkg(dir, name)) return { ok: false, text: `${name} 未在插件库中` }
    // PHYSICALLY delete the whole archived dir — the overview scans folders, so
    // any leftover keeps the plugin visible. Windows can still hold a junction'd
    // file open for a brief beat after the profile link is released, so retry.
    try {
      deleteTreePhysical(pRoot)
    } catch (error) {
      return { ok: false, text: `${name} 删除失败（目录被占用）：${error instanceof Error ? error.message : String(error)}` }
    }
    pruneEmptyScopes(dirname(pRoot))
    legacyRemove(dir, name)
    if (existsSync(pRoot)) {
      // A residual archive dir means the physical delete did not fully land — do
      // not pretend otherwise; the overview will still show the plugin.
      logger.warn(`plugin store: archive dir still present after remove for ${name}`)
      return { ok: false, text: `${name} 的归档目录仍残留（可能被 profile 引用占用），请先在 profile 中移除其引用后重试` }
    }
    logger.info(`plugin store remove: ${name}`)
    return { ok: true, text: `已删除 ${name}` }
  }
  const tgt = pluginVersionDir(dir, name, version)
  if (!existsSync(tgt)) return { ok: false, text: `${name}@${version} 未在插件库中` }
  deleteTreePhysical(tgt)
  // Drop the plugin dir once its last version is gone.
  if (existsSync(pRoot) && readdirSync(pRoot).filter(e => e !== '.staging').length === 0) {
    deleteTreePhysical(pRoot)
  }
  pruneEmptyScopes(dirname(pRoot))
  logger.info(`plugin store remove: ${name}@${version}`)
  return { ok: true, text: `已删除 ${name}@${version}` }
}

/** True when `name` still exists in the legacy top-level layout. */
function isLegacyPkg(dir: string, name: string): boolean {
  return existsSync(join(dir, 'node_modules', name))
}

/** Remove a legacy top-level installed package (manifest dep + node_modules). */
function legacyRemove(dir: string, name: string): void {
  const manifestPath = join(dir, 'package.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StoreManifest
      if (manifest.dependencies?.[name] !== undefined) {
        delete manifest.dependencies[name]
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
      }
    } catch { /* ignore */ }
  }
  rmSync(join(dir, 'node_modules', name), { recursive: true, force: true })
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
    const v = latestStoreVersion(storeDir, name)
    if (v !== undefined) {
      const storePkg = join(pluginVersionDir(storeDir, name, v), 'node_modules', name)
      if (existsSync(join(storePkg, 'package.json'))) return storePkg
    }
    // legacy layout fallback: an upgraded store may still carry plugins at the flat
    // node_modules root (their dependencies are hoisted there — leave them in place).
    const legacy = join(storeDir, 'node_modules', name)
    if (existsSync(join(legacy, 'package.json'))) return legacy
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
      row = { name, versions: [], usage: [], inStore: false, sources: [] }
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
          // Resolve the version actually installed into this profile's
          // node_modules — the per-profile truth of "which version is applied".
          const resolved = readVersion(join(pkgNodeModules, name))
          row.usage.push({ dsh: dsh.name, dshVersion: dsh.version, profile, version: resolved })
          noteVersion(row, resolved)
        }
    }
  }

  // Store-local downloads — every archived version counts as in-store. Its
  // origin comes from the sidecar where the download recorded it; a version with
  // no record (pre-tracking store, or a hand-placed package) is a generic "store".
  if (storeDir !== '') {
    const origin = readPluginSources(storeDir)
    for (const p of listPlugins(storeDir)) {
      const row = getRow(p.name)
      row.inStore = true
      const kind = origin[`${p.name}@${p.version}`] ?? 'store'
      if (!row.sources.includes(kind)) row.sources.push(kind)
      noteVersion(row, p.version)
    }
  }

  // A package that's in use but not in the store is a dsh-bundled template
  // (e.g. @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app) — mark it as built-in,
  // not a plugin the user can manage/uninstall from the store.
  return [...rows.values()]
    .map(row => {
      const builtin = row.inStore !== true && row.usage.length > 0
      return {
        ...row,
        builtin,
        // A dsh-bundled template is sourced from the harness itself.
        sources: builtin && !row.sources.includes('dsh' as PluginSource) ? [...row.sources, 'dsh' as PluginSource] : row.sources,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Point a profile at a locally-downloaded plugin in the store via a `link:`
 * dependency, run the profile's pnpm install, and reconcile bundles.
 *
 * Returns `{ ok, text, activated }` where `activated` tells whether the plugin
 * declared `dsh.bundle` and was appended to the profile's bundle layer.
 */
/** Resolve the versioned node_modules dir for an archived plugin, or null. */
function targetVersionedPkgDir(storeDir: string, pkg: string, opts: { version?: string }): string | null {
  const version = opts.version ?? latestStoreVersion(storeDir, pkg)
  if (version === undefined) return null
  return join(pluginVersionDir(storeDir, pkg, version), 'node_modules', pkg)
}

/**
 * Point a profile at one archived version of a plugin via a `link:` dependency,
 * run the profile's pnpm install, and reconcile bundles. `version` selects the
 * specific archived copy; when omitted, the highest archived version is used.
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
  const spec = `link:${pkgDir}`
  if (manifest.dependencies[pkg] !== spec) {
    manifest.dependencies[pkg] = spec
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }

  const install = await runPnpm(dir, ['install'])
  if (!install.ok) return { ok: false, text: `pnpm install 失败：${install.text}`, activated: false }

  // Bundle reconcile: a dependency that declares `dsh.bundle` joins the layer.
  const storeManifestPath = join(pkgDir, 'package.json')
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