/**
 * Removing plugins from the store — physically deleting archived versions (with
 * the symlink/junction-safe tree deletion Windows needs) and detaching a plugin
 * from every profile that links into it, so the archive can actually be freed.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { runPnpm } from '../dsh/pnpm.ts'
import { logger } from '../shared/logger.ts'
import { pathWithin } from '../profile/name-guard.ts'
import { pluginVersionDir, versionsRoot, type ProfileManifestShape } from './layout.ts'
import { readDeps, readRef } from './refstate.ts'
import { listBundleSubdepNames } from './subdeps.ts'
import { profilesRoot, type DshScope } from '../profile/appState.ts'
import type { PluginUsagePoint } from '../../../shared/types.ts'

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

/** True when `name` still exists in the legacy top-level layout. Shared with the
 * install path, which must link a legacy package without a versioned copy. */
export function isLegacyPkg(dir: string, name: string): boolean {
  return existsSync(join(dir, 'node_modules', name))
}

/** Remove a legacy top-level installed package (manifest dep + node_modules). */
function legacyRemove(dir: string, name: string): void {
  const manifestPath = join(dir, 'package.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
      if (manifest.dependencies?.[name] !== undefined) {
        delete manifest.dependencies[name]
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
      }
    } catch { /* ignore */ }
  }
  rmSync(join(dir, 'node_modules', name), { recursive: true, force: true })
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
export async function removePluginFromProfiles(
  dshes: DshScope[], pkg: string, opts?: { only?: (home: string, profile: string) => boolean },
): Promise<PluginUsagePoint[]> {
  const affected: PluginUsagePoint[] = []
  for (const dsh of dshes) {
    const dir = profilesRoot(dsh.home)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (opts?.only !== undefined && !opts.only(dsh.name, entry.name)) continue
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
      // Also drop the sub-bundle `link:` deps this aggregate bundle pulled into the
      // profile, so removing it leaves no orphaned links (the `pnpm install` below
      // prunes the leftover junctions).
      if (isLinked && typeof spec === 'string') {
        const pkgDir = spec.startsWith('file:') ? spec.slice('file:'.length) : spec.slice('link:'.length)
        for (const sub of listBundleSubdepNames(pkgDir)) {
          if (manifest.dependencies?.[sub] !== undefined) delete manifest.dependencies[sub]
        }
      }
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
      await runPnpm(profileDirPath, ['install', '--config.confirmModulesPurge=false'])
      affected.push({ dsh: dsh.name, dshVersion: dsh.version, profile: entry.name })
    }
  }
  return affected
}

/** Detach a plugin from the profiles `pick` selects. `removePluginFromProfiles`
 * with no filter, named separately so a selective detach reads as deliberate at
 * the call site. The selector takes the dsh NAME, because that is what a usage
 * point — the thing the caller is filtering — actually carries. */
export async function detachProfiles(
  dshes: DshScope[], pkg: string, pick: (dshName: string, profile: string) => boolean,
): Promise<PluginUsagePoint[]> {
  return removePluginFromProfiles(dshes, pkg, { only: pick })
}

/**
 * Every profile that still points at one specific store path.
 *
 * Deleting an archived version used to detach nobody, so a profile switched to
 * that version kept a `file:` spec aimed at a directory that no longer existed.
 * The reference is only findable by comparing the DECLARED spec against the path
 * about to be deleted — the profile side cannot see it by itself, because a
 * dangling junction reads exactly like a package that was never installed.
 *
 * The comparison is a containment question, so it goes through
 * {@link pathWithin} rather than a string prefix: the spec's spelling comes from
 * whatever wrote the manifest (an earlier store setting, another machine, a hand
 * edit) while `target` comes from the setting now, and on Windows those may
 * differ in case while naming the same directory. A prefix test answered "nobody
 * references this" and let the delete through.
 */
export function profilesPointingAt(dshes: DshScope[], pkg: string, target: string): PluginUsagePoint[] {
  const wanted = resolve(target)
  const found: PluginUsagePoint[] = []
  for (const dsh of dshes) {
    const dir = profilesRoot(dsh.home)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const profileDirPath = join(dir, entry.name)
      const manifestPath = join(profileDirPath, 'package.json')
      if (!existsSync(manifestPath)) continue
      const ref = readRef(pkg, profileDirPath, readDeps(manifestPath)[pkg])
      // A spec names the package BODY (`file:<version>/node_modules/<pkg>`), not the
      // version dir, so match the dir or anything inside it.
      if (ref.target !== undefined && pathWithin(wanted, ref.target)) {
        found.push({ dsh: dsh.name, dshVersion: dsh.version, profile: entry.name, ...(ref.spec !== undefined ? { spec: ref.spec } : {}) })
      }
    }
  }
  return found
}

/** A profile's identity, for matching a usage point back to its directory. */
function usageKey(home: string, profile: string): string {
  return `${home}\u0000${profile}`
}

/**
 * Remove ONE archived version, refusing while any profile still points at it.
 *
 * Deleting a version is a library-side act; detaching the profiles that depend on
 * it is a profile-side one. Doing only the first is how a profile ends up holding
 * a `file:` aimed at nothing while the UI still reports it as in use. So the
 * question is asked FIRST, and the answer is either "who" (blocked) or "do both".
 * `detach: true` is the explicit "do both" — never the default, because removing
 * a reference from someone else's profile is a decision, not a side effect.
 */
export async function removeArchivedVersion(
  dshes: DshScope[], dir: string, pkg: string, version: string, opts?: { detach?: boolean },
): Promise<{ ok: boolean; text: string; blockedBy?: PluginUsagePoint[] }> {
  if (dir === '') return { ok: false, text: '未配置插件保存位置 —— 请在「设置」中指定' }
  if (version === '.' || version === '..') return { ok: false, text: `非法版本号：${version}` }
  const target = pluginVersionDir(dir, pkg, version)
  if (!existsSync(target)) return { ok: false, text: `${pkg}@${version} 未在插件库中` }
  const referencing = profilesPointingAt(dshes, pkg, target)
  if (referencing.length > 0 && opts?.detach !== true) {
    const where = referencing.map(u => `${u.dsh}·${u.profile}`).join('、')
    return { ok: false, text: `${pkg}@${version} 仍被这些 profile 引用：${where}。先断开引用再删除。`, blockedBy: referencing }
  }
  if (referencing.length > 0) {
    const only = new Set(referencing.map(u => usageKey(u.dsh, u.profile)))
    await detachProfiles(dshes, pkg, (home, profile) => only.has(usageKey(home, profile)))
  }
  const res = removePlugin(dir, pkg, version)
  return res.ok
    ? { ok: true, text: `${res.text}（已从 ${referencing.length} 个 profile 断开引用）` }
    : res
}

/** Uninstall a plugin from the store. Without `version` the whole plugin (every
 * archived version) is removed; with it, only that one archived version goes.
 *
 * The single-version form has a guard the whole-plugin form does not need — see
 * `removeArchivedVersion`, which is what a delete should go through. */
export function removePlugin(dir: string, name: string, version?: string): { ok: boolean; text: string } {
  if (dir === '') return { ok: false, text: '未配置插件保存位置 —— 请在「设置」中指定' }
  // Defense in depth: `.`/`..` pass the (character-class) version validation but
  // join OUT of the version dir — `..` would resolve to `archive/` itself and
  // wipe every plugin. Refuse before any path is built.
  if (version === '.' || version === '..') return { ok: false, text: `非法版本号：${version}` }
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