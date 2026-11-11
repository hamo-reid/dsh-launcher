/**
 * Removing plugins from the store — physically deleting archived versions (with
 * the symlink/junction-safe tree deletion Windows needs) and detaching a plugin
 * from every profile that links into it, so the archive can actually be freed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { runPnpm } from '../dsh/pnpm.ts'
import { logger } from '../shared/logger.ts'
import { pathWithin } from '../profile/name-guard.ts'
import { pluginVersionDir, versionsRoot } from './layout.ts'
import { readDeps, readRef } from './refstate.ts'
import { listBundleSubdepNames } from './subdeps.ts'
import { localSpecPath, scanPluginUsages } from './usage.ts'
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
export function deleteTreePhysical(dir: string, failures: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    try { rmSync(dir, { recursive: true, force: true }) } catch { failures.push(dir) }
    return failures
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    // A path that cannot be removed is COLLECTED, never thrown: one locked file
    // must not abandon the rest of the tree half-deleted. The caller decides what
    // a leftover means; on Windows it usually means a process still holds it.
    try {
      if (entry.isSymbolicLink()) {
        // unlink the link itself (stop it from pinning the tree / following into a
        // target) — never recurse into what it points at. Must use unlinkSync, not
        // rmSync: a bare rmSync on a junction throws ERR_FS_EISDIR on Windows.
        unlinkSync(full)
      } else if (entry.isDirectory()) {
        deleteTreePhysical(full, failures)
      } else {
        rmSync(full, { force: true })
      }
    } catch {
      failures.push(full)
    }
  }
  try { rmSync(dir, { recursive: true, force: true }) } catch { failures.push(dir) }
  return failures
}

/** The store's stash area: bytes already out of the version namespace but not yet
 * deleted. It sits at the store ROOT (never under `archive/`), so the version
 * enumeration cannot mistake a leftover for an installed version. */
function storeTrashDir(storeDir: string): string {
  return join(storeDir, '.trash')
}

/**
 * Take an archive path out of the store's namespace, then delete its bytes.
 *
 * A rename and a recursive delete differ on Windows in exactly the way that
 * matters: a directory holding an open file can usually still be MOVED, while the
 * file itself cannot be removed. Moving first means the version is already gone
 * from the version enumeration (which only reads `archive/`) before a single byte
 * is deleted — so a locked file leaves a reclaimable leftover in the stash instead
 * of a half-deleted archive that still reads as installed.
 * @param storeDir - The store root.
 * @param target - The archive path to retire (a version dir or a whole plugin dir).
 * @param leaf - Stash name; unique per call so two removals never collide.
 * @returns `moved` is false when the move itself was refused — the archive is
 *   then left exactly as it was, because a store that refused to change beats a
 *   broken one. `failures` names what the delete could not reclaim.
 */
export function retireTree(
  storeDir: string, target: string, leaf: string,
): { moved: boolean; failures: string[] } {
  const stash = join(storeTrashDir(storeDir), leaf)
  try {
    // Preparing the stash is part of "can this be retired at all": a store whose
    // stash cannot be created must report the refusal, not throw from a delete.
    mkdirSync(storeTrashDir(storeDir), { recursive: true })
    rmSync(stash, { recursive: true, force: true })
    renameSync(target, stash)
  } catch (error) {
    logger.warn(`plugin store: could not move ${target} aside: ${error instanceof Error ? error.message : String(error)}`)
    return { moved: false, failures: [target] }
  }
  return { moved: true, failures: deleteTreePhysical(stash) }
}

/** A stash leaf name: the package (scoped names flattened) plus a discriminator. */
function stashLeaf(pkg: string, suffix: string): string {
  return `${pkg.replace(/[\\/]/g, '+')}@${suffix}`
}

/**
 * Retry the stashed leftovers of an earlier removal. Runs at startup: the process
 * that held a file open has usually exited by then, so what could not be deleted
 * during a live session can be now. Best effort — a leftover is invisible to the
 * overview, so failing again costs disk and nothing else.
 * @param storeDir - The store root; `''` is a no-op.
 */
export function sweepStoreTrash(storeDir: string): void {
  if (storeDir === '') return
  const trash = storeTrashDir(storeDir)
  if (!existsSync(trash)) return
  for (const entry of readdirSync(trash)) {
    const failures = deleteTreePhysical(join(trash, entry))
    if (failures.length === 0) logger.info(`plugin store: reclaimed stashed ${entry}`)
    else logger.warn(`plugin store: ${entry} is still held open (${failures.length} path(s))`)
  }
  try {
    if (readdirSync(trash).length === 0) rmSync(trash, { recursive: true, force: true })
  } catch { /* still in use; the next start retries */ }
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
  dshes: DshScope[], pkg: string, opts?: { only?: (dshName: string, profile: string) => boolean },
): Promise<PluginUsagePoint[]> {
  const affected: PluginUsagePoint[] = []
  // Discovery is `scanPluginUsages`, the same predicate the "is it in use by a
  // running profile" guards consult. Acting on a different set than the guard
  // judged is how a refusal and a cascade end up disagreeing.
  for (const item of scanPluginUsages(dshes, pkg, opts)) {
    const { dir, manifest, spec, inBundles, nmStat } = item
    const manifestPath = join(dir, 'package.json')
    if (manifest.dependencies?.[pkg] !== undefined) delete manifest.dependencies[pkg]
    // Also drop the sub-bundle `link:` deps this aggregate bundle pulled into the
    // profile, so removing it leaves no orphaned links (the `pnpm install` below
    // prunes the leftover junctions).
    const localPath = localSpecPath(spec)
    if (localPath !== undefined) {
      for (const sub of listBundleSubdepNames(localPath)) {
        if (manifest.dependencies?.[sub] !== undefined) delete manifest.dependencies[sub]
      }
    }
    if (inBundles) {
      const bundles = manifest.dsh?.profile?.bundles ?? []
      manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: bundles.filter(b => b !== pkg) } }
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    // PHYSICALLY remove the plugin's folder here. A leftover junction must be
    // unlinked directly (never recursed into), else it keeps pinning the store
    // archive. A real directory is deleted via deleteTreePhysical (symlink-safe).
    const nmPkg = join(dir, 'node_modules', pkg)
    if (nmStat !== undefined) {
      // The reference is already gone from the manifest, so a link that will not
      // unlink is REPORTED rather than thrown: one stubborn profile must not abort
      // the detach of the others, and `pnpm install` below usually prunes it
      // anyway. Silently ignoring it is what leaves an archive pinned for reasons
      // nobody can see.
      try {
        if (nmStat.isSymbolicLink()) {
          // isSymbolicLink() is true for a Windows junction too, but a bare rmSync
          // on a junction throws ERR_FS_EISDIR — unlink (remove the link entry, do
          // not follow it) is the only reliable path for both.
          unlinkSync(nmPkg)
        } else {
          const stranded = deleteTreePhysical(nmPkg)
          if (stranded.length > 0) {
            logger.warn(`plugin detach: ${stranded.length} path(s) under ${nmPkg} could not be removed`, { profile: item.usage.profile })
          }
        }
      } catch (error) {
        logger.warn(`plugin detach: could not unlink ${nmPkg}`, {
          profile: item.usage.profile, error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    await runPnpm(dir, ['install', '--config.confirmModulesPurge=false'])
    // The spec is gone now, so it is not part of what was detached.
    const { dsh, dshId, dshVersion, profile } = item.usage
    affected.push({ dsh, dshId, ...(dshVersion !== undefined ? { dshVersion } : {}), profile })
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
        found.push({ dsh: dsh.name, dshId: dsh.id, dshVersion: dsh.version, profile: entry.name, ...(ref.spec !== undefined ? { spec: ref.spec } : {}) })
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
): Promise<{ ok: boolean; text: string; blockedBy?: PluginUsagePoint[]; locked?: true }> {
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
export function removePlugin(
  dir: string, name: string, version?: string,
): { ok: boolean; text: string; locked?: true } {
  if (dir === '') return { ok: false, text: '未配置插件保存位置 —— 请在「设置」中指定' }
  // Defense in depth: `.`/`..` pass the (character-class) version validation but
  // join OUT of the version dir — `..` would resolve to `archive/` itself and
  // wipe every plugin. Refuse before any path is built.
  if (version === '.' || version === '..') return { ok: false, text: `非法版本号：${version}` }
  const pRoot = join(versionsRoot(dir), name)
  if (version === undefined) {
    if (!existsSync(pRoot) && !isLegacyPkg(dir, name)) return { ok: false, text: `${name} 未在插件库中` }
    // Retire the whole archived dir. Moving it aside first is what keeps a locked
    // file from leaving a half-deleted archive the overview still lists.
    const { moved, failures } = retireTree(dir, pRoot, stashLeaf(name, `all.${Date.now()}`))
    if (!moved) return { ok: false, locked: true, text: `${name} 的归档目录被占用，无法移出` }
    pruneEmptyScopes(dirname(pRoot))
    legacyRemove(dir, name)
    logger.info(`plugin store remove: ${name}`)
    return failures.length === 0
      ? { ok: true, text: `已删除 ${name}` }
      : { ok: true, text: `已移除 ${name}；${failures.length} 个文件仍被占用，已移入 .trash 待下次启动重试` }
  }
  const tgt = pluginVersionDir(dir, name, version)
  if (!existsSync(tgt)) return { ok: false, text: `${name}@${version} 未在插件库中` }
  const { moved, failures } = retireTree(dir, tgt, stashLeaf(name, `${version}.${Date.now()}`))
  if (!moved) return { ok: false, locked: true, text: `${name}@${version} 的归档目录被占用，无法移出` }
  // Drop the plugin dir once its last version is gone.
  if (existsSync(pRoot) && readdirSync(pRoot).filter(e => e !== '.staging').length === 0) {
    deleteTreePhysical(pRoot)
  }
  pruneEmptyScopes(dirname(pRoot))
  logger.info(`plugin store remove: ${name}@${version}`)
  return failures.length === 0
    ? { ok: true, text: `已删除 ${name}@${version}` }
    : { ok: true, text: `已移除 ${name}@${version}；${failures.length} 个文件仍被占用，已移入 .trash 待下次启动重试` }
}