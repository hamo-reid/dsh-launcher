/** The plugin store itself: where it is, what is in it, installing
 * into and removing from it, and showing one to the user. */

import { dialog, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  addLocalPlugin, addPlugin, buildInstalledOverview, findInstalledDir, initStore, installIntoProfile, listPlugins,
  listProfileScopes, readPluginReadme, removeArchivedVersion, removePlugin, removePluginFromProfiles,
} from '../../core/store/plugins.ts'
import { listComboPlugins } from '../../core/store/combo.ts'
import { dshScopes, pluginDir, profilesRootFor, type DshScope } from '../../core/profile/appState.ts'
import { inlineRelativeImages } from '../../core/shared/app-util.ts'
import { fetchPackageVersions, npmSearch } from '../../core/store/npm.ts'
import { attachPluginSizes } from '../../core/store/overview.ts'
import { fail, failFromError, E } from '../../core/shared/errors.ts'
import { pathIdentifierInvalid, versionInvalid } from '../validate.ts'
import { ctxOf } from '../ctxOf.ts'
import { handle } from '../handle.ts'
import type {
  ComboPlugin, InstalledOverviewRow, IpcResult, NpmSearchHit, PackageVersionInfo, PluginUsagePoint,
} from '../../../shared/types.ts'

/** Validate a candidate plugin dir and make it usable: create it, prove it is
 * writable, reject a non-object `package.json`, and initialise the pnpm
 * project. Returns the resolved path.
 *
 * It deliberately does NOT persist anything. The launcher data root owns that
 * write (`ipc/app/data-root.ts`), and keeping the two apart is what lets a
 * failed migration leave the settings untouched. */
export function ensurePluginStore(dir: string): IpcResult<string> {
  // Validate the chosen location before it is used, so the user gets a precise
  // message instead of a quiet failure on the next install.
  const trimmed = dir.trim()
  if (trimmed === '') return fail(E.nameInvalid)
  const target = resolve(trimmed)
  try {
    if (existsSync(target) && !statSync(target).isDirectory()) {
      return fail(E.storeNotDir, { path: target })
    }
    mkdirSync(target, { recursive: true })
    // Write-probe: the directory must actually be usable as a store.
    const probe = join(target, '.pm-write-probe')
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    // A pre-existing package.json must be a valid JSON object (this dir will
    // double as a pnpm project once plugins are installed).
    const manifestPath = join(target, 'package.json')
    if (existsSync(manifestPath)) {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return fail(E.storeBadManifest, { path: manifestPath })
      }
    }
    initStore(target)
    return { ok: true, value: target }
  } catch (error) {
    return fail(E.storeUnusable, { detail: String(error) })
  }
}

export function registerStoreIpc(): void {
  handle('plugins:getDir', (): IpcResult<{ dir: string }> => {
    try {
      return { ok: true, value: { dir: pluginDir() } }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('plugins:list', async (): Promise<IpcResult<{ name: string; version: string }[]>> => {
    try {
      return { ok: true, value: listPlugins(pluginDir()) }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('plugins:add', async (_event, source: string, name?: string): Promise<IpcResult<string>> => {
    try {
      if (name !== undefined && pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      const result = await addPlugin(pluginDir(), source, name)
      return result.ok ? { ok: true, value: '已下载到本地存储：' + result.text } : fail(E.storeInstallFailed, { detail: result.text })
    } catch (error) {
      return failFromError(error)
    }
  })

  // Install from a local .zip: pick the archive, then add it through the same pnpm
  // pipeline a network download uses. A bare DIRECTORY is no longer an entry point
  // here — the dev-plugin flow registers a folder itself, and a profile import
  // pulls its own local dirs — so the dialog only offers archives.
  handle('plugins:addLocal', async (): Promise<IpcResult<string>> => {
    try {
      const store = pluginDir()
      if (store === '') return fail(E.storeNotConfigured)
      const picked = await dialog.showOpenDialog({
        title: '选择插件 .zip 包',
        properties: ['openFile'],
        filters: [{ name: '插件包', extensions: ['zip'] }],
      })
      if (picked.canceled || picked.filePaths.length === 0) return fail(E.commonCancelled)
      const result = await addLocalPlugin(store, picked.filePaths[0])
      return result.ok ? { ok: true, value: '已从本地加入本地存储：' + result.text } : fail(E.storeInstallFailed, { detail: result.text })
    } catch (error) {
      return failFromError(error)
    }
  })

  // Chooseable DSH→profiles for the install picker.
  handle('plugins:installOptions', (): IpcResult<{ id: string; name: string; version?: string; profiles: string[] }[]> => {
    try {
      return { ok: true, value: listProfileScopes(dshScopes()) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Point a profile (under an explicit dsh) at a locally-downloaded plugin.
  handle('plugins:installToProfile', async (_event, dshId: string, profile: string, pkg: string, version?: string): Promise<IpcResult<string>> => {
    try {
      const ctx = ctxOf(dshId)
      if (ctx === null) return fail(E.dshNotFound)
      if (pathIdentifierInvalid(profile) || pathIdentifierInvalid(pkg)) return fail(E.nameInvalid)
      if (version !== undefined && versionInvalid(version)) return fail(E.nameInvalid)
      const result = await installIntoProfile(profilesRootFor(ctx), profile, pkg, pluginDir(), { version })
      return result.ok ? { ok: true, value: result.text } : fail(E.storeOperationFailed, { detail: result.text })
    } catch (error) {
      return failFromError(error)
    }
  })

  // Delete one archived version. REFUSES while a profile still points at it, and
  // names the profiles — deleting a version and detaching the profiles that
  // depend on it are two different acts, and only the first used to happen.
  handle('plugins:remove', async (
    _event, name: string, version?: string, opts?: { detach?: boolean },
  ): Promise<IpcResult<{ text: string; detached: PluginUsagePoint[] }>> => {
    try {
      if (pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      if (version !== undefined && versionInvalid(version)) return fail(E.nameInvalid)
      if (version === undefined) {
        // Whole-plugin removal detaches every referencing profile by design.
        const detached = await removePluginFromProfiles(dshScopes(), name)
        const res = removePlugin(pluginDir(), name)
        if (!res.ok) return fail(E.storeOperationFailed, { detail: res.text })
        return { ok: true, value: { text: res.text, detached } }
      }
      const res = await removeArchivedVersion(dshScopes(), pluginDir(), name, version, {
        ...(opts?.detach === true ? { detach: true } : {}),
      })
      if (!res.ok) {
        // A blocked delete is its own outcome, not an operation failure: the user
        // needs to see WHO holds the version, then choose. It carries its own code
        // so the renderer can offer "detach those and delete" rather than
        // showing a dead end.
        return res.blockedBy !== undefined
          ? fail(E.storeVersionInUse, { name, version, profiles: res.blockedBy.map(u => `${u.dsh}·${u.profile}`).join('、') })
          : fail(E.storeOperationFailed, { detail: res.text })
      }
      return { ok: true, value: { text: res.text, detached: res.blockedBy ?? [] } }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Cascade "full uninstall": detach the plugin from every profile that links it
  // (dropping the link dep + bundle layer + pnpm install frees the store archive
  // from junction-occupied Windows), then remove the whole plugin from the store.
  // Returns which profiles were detached so the renderer can surface them.
  handle('plugins:uninstall', async (_event, name: string): Promise<IpcResult<{ removed: PluginUsagePoint[] }>> => {
    try {
      if (pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      const removed = await removePluginFromProfiles(dshScopes(), name)
      const res = removePlugin(pluginDir(), name)
      if (!res.ok) return fail(E.storeOperationFailed, { detail: res.text })
      return { ok: true, value: { removed } }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Detach a plugin from profiles WITHOUT touching the library. The one operation
  // the store page had no way to express: `uninstall` also deletes the archive, and
  // unregistering a dev plugin deliberately touches no profile at all.
  // No `targets` = every profile that references it; given = only those.
  // Targets are addressed by dsh NAME, because a usage point — which is what the
  // UI hands back — carries the name and nothing else to address with.
  handle('plugins:detach', async (
    _event, name: string, targets?: { dsh: string; profile: string }[],
  ): Promise<IpcResult<{ detached: PluginUsagePoint[] }>> => {
    try {
      if (pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      const scopes = dshScopes()
      if (targets === undefined) {
        return { ok: true, value: { detached: await removePluginFromProfiles(scopes, name) } }
      }
      const wanted = new Set<string>()
      const list: DshScope[] = []
      for (const raw of targets) {
        if (pathIdentifierInvalid(raw.profile)) return fail(E.nameInvalid)
        const scope = scopes.find(s => s.name === raw.dsh)
        if (scope === undefined) return fail(E.dshNotFound, { detail: raw.dsh })
        if (!list.includes(scope)) list.push(scope)
        wanted.add(`${scope.name}\u0000${raw.profile}`)
      }
      const detached = await removePluginFromProfiles(list, name, {
        only: (dshName, profile) => wanted.has(`${dshName}\u0000${profile}`),
      })
      return { ok: true, value: { detached } }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('plugins:search', async (_event, query: string, opts?: { from?: number; size?: number }): Promise<IpcResult<{ hits: NpmSearchHit[]; total: number }>> => {
    try {
      return { ok: true, value: await npmSearch(query, opts) }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('plugins:pkgVersions', async (_event, name: string): Promise<IpcResult<PackageVersionInfo>> => {
    try {
      if (pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      return { ok: true, value: await fetchPackageVersions(name) }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('plugins:listCombo', (_event, dshId: string, profile: string): IpcResult<ComboPlugin[]> => {
    try {
      const ctx = ctxOf(dshId)
      if (ctx === null) return fail(E.dshNotFound)
      return { ok: true, value: listComboPlugins(ctx, profile) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Installed-plugin overview: usage across DSH/profiles + store flag.
  handle('plugins:overview', (): IpcResult<InstalledOverviewRow[]> => {
    try {
      return { ok: true, value: buildInstalledOverview(dshScopes(), pluginDir()) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Size statistics are MANUAL (triggered by the "calculate sizes" button), not
  // computed on every overview load: walking each archived node_modules is costly.
  handle('plugins:calcSizes', (): IpcResult<Record<string, number>> => {
    try {
      const rows = buildInstalledOverview(dshScopes(), pluginDir())
      attachPluginSizes(rows, dshScopes(), pluginDir())
      const sizes: Record<string, number> = {}
      for (const row of rows) if (row.sizeBytes !== undefined) sizes[row.name] = row.sizeBytes
      return { ok: true, value: sizes }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Read a plugin's README markdown for display. Relative image paths are inlined
  // to data: URLs so they load in both dev (http) and packaged (file) renderers.
  handle('plugins:readme', (_event, name: string): IpcResult<{ content: string; dir: string }> => {
    try {
      const scopes = dshScopes()
      const dir = findInstalledDir(scopes, pluginDir(), name)
      const raw = readPluginReadme(scopes, pluginDir(), name)
      const content = dir !== undefined ? inlineRelativeImages(raw, dir) : raw
      return { ok: true, value: { content, dir: dir ?? '' } }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Reveal a plugin's install dir in the OS file explorer.
  handle('plugins:reveal', (_event, name: string): IpcResult<boolean> => {
    try {
      const scopes = dshScopes()
      const dir = findInstalledDir(scopes, pluginDir(), name)
      if (dir === undefined) return fail(E.pluginNotInstalled, { name })
      shell.showItemInFolder(dir)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

}
