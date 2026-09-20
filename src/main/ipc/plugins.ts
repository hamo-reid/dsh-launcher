/** IPC for the plugin store (`plugins:*`): store dir, network/local downloads,
 * install-into-profile, search, overview, README and reveal. */

import { BrowserWindow, dialog, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  addLocalPlugin, addPlugin, buildInstalledOverview, findInstalledDir, initStore, installIntoProfile, listPlugins,
  listProfileScopes, readPluginReadme, removePlugin, removePluginFromProfiles, storeVersions,
} from '../core/plugins.ts'
import { listComboPlugins } from '../core/combo.ts'
import {
  cancelPluginDownload, cleanupPluginDownloads, listPluginDownloads, onDownloadsChange, onDownloadsSettled, startPluginDownload,
} from '../core/pluginDownloads.ts'
import { checkPluginUpdates } from '../core/plugin-updates.ts'
import { installSpecFor, marketSourceState, resolveMarket } from '../core/market.ts'
import { contextForEntry, dshEntryById, dshScopes, pluginDir, profilesRootFor, type DshContext } from '../core/appState.ts'
import { isProfileRunning, listRuns } from './run.ts'
import { patchSettings } from '../core/settings.ts'
import { inlineRelativeImages } from '../core/app-util.ts'
import { fetchPackageVersions, npmSearch } from '../core/npm.ts'
import { attachPluginSizes } from '../core/store-overview.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { pathIdentifierInvalid, versionInvalid } from './validate.ts'
import { handle } from './handle.ts'
import type { ComboPlugin, DownloadSessionInfo, InstalledOverviewRow, IpcResult, NpmSearchHit, PackageVersionInfo, PluginApplyResult, PluginCleanupResult, PluginMigrationResult, PluginUpdateInfo, PluginUsagePoint } from '../../shared/types.ts'

/** Validate + persist the plugin-store location (shared by `plugins:setDir`
 * and the onboarding wizard). On success the dir is made usable and saved. */
export function setPluginStoreDir(dir: string): IpcResult<boolean> {
  // Validate the chosen location before persisting it, so the user gets a
  // precise message instead of a quiet failure on next install.
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
    patchSettings({ pluginDir: target })
    return { ok: true, value: true }
  } catch (error) {
    return fail(E.storeUnusable, { detail: String(error) })
  }
}

/** Resolve an explicit dsh id to its context, or `null` when unknown. */
function ctxOf(dshId: unknown): DshContext | null {
  if (typeof dshId !== 'string') return null
  const entry = dshEntryById(dshId)
  return entry === undefined ? null : contextForEntry(entry)
}

export function registerPluginsIpc(): void {
  handle('plugins:getDir', (): IpcResult<{ dir: string }> => {
    try {
      return { ok: true, value: { dir: pluginDir() } }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('plugins:setDir', (_event, dir: string): IpcResult<boolean> =>
    setPluginStoreDir(dir))

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

  // Install from a LOCAL source: pick a plugin folder or .zip, add it to the
  // store via the same pnpm pipeline as a network download. `kind` picks the
  // dialog mode so folder vs .zip are two explicit, unambiguous entries.
  handle('plugins:addLocal', async (_event, kind: 'folder' | 'zip'): Promise<IpcResult<string>> => {
    try {
      const store = pluginDir()
      if (store === '') return fail(E.storeNotConfigured)
      const isZip = kind === 'zip'
      const picked = await dialog.showOpenDialog({
        title: isZip ? '选择插件 .zip 包' : '选择插件文件夹',
        properties: isZip ? ['openFile'] : ['openDirectory'],
        filters: isZip ? [{ name: '插件包', extensions: ['zip'] }] : undefined,
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

  handle('plugins:remove', async (_event, name: string, version?: string): Promise<IpcResult<string>> => {
    try {
      if (pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      if (version !== undefined && versionInvalid(version)) return fail(E.nameInvalid)
      const result = await removePlugin(pluginDir(), name, version)
      return result.ok ? { ok: true, value: result.text } : fail(E.storeOperationFailed, { detail: result.text })
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

  // Update detection (manual trigger): compare store-installed plugins against
  // npm's `latest`. Memoized in the core with a short TTL; `refresh` bypasses it.
  handle('plugins:checkUpdates', async (_event, opts?: { refresh?: boolean }): Promise<IpcResult<PluginUpdateInfo[]>> => {
    try {
      return { ok: true, value: await checkPluginUpdates(dshScopes(), pluginDir(), opts ?? {}) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Apply one or more plugin version updates to a SPECIFIC profile: ensure each
  // target version is archived, then re-point the profile's `file:` dependency.
  // Refused while the profile runs — mutating a live profile's node_modules
  // would race its runtime (same guard as rename/delete).
  handle('plugins:applyUpdates', async (
    _event, dshId: string, profile: string, updates: { name: string; version: string }[],
  ): Promise<IpcResult<{ results: PluginApplyResult[] }>> => {
    try {
      const ctx = ctxOf(dshId)
      if (ctx === null) return fail(E.dshNotFound)
      if (pathIdentifierInvalid(profile)) return fail(E.nameInvalid)
      if (!Array.isArray(updates)) return fail(E.nameInvalid)
      if (isProfileRunning(dshId, profile)) return fail(E.runAlreadyRunning, { profile })
      const store = pluginDir()
      const results: PluginApplyResult[] = []
      for (const update of updates) {
        const name = typeof update?.name === 'string' ? update.name : ''
        const version = typeof update?.version === 'string' ? update.version : ''
        if (pathIdentifierInvalid(name) || versionInvalid(version)) {
          results.push({ name, version, ok: false, text: 'invalid update target' })
          continue
        }
        if (!storeVersions(store, name).includes(version)) {
          const added = await addPlugin(store, `${name}@${version}`, name)
          if (!added.ok) { results.push({ name, version, ok: false, text: added.text }); continue }
        }
        const linked = await installIntoProfile(profilesRootFor(ctx), profile, name, store, { version })
        results.push({ name, version, ok: linked.ok, text: linked.text })
      }
      return { ok: true, value: { results } }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Garbage-collect a plugin's UNUSED archived versions (keep the newest, and any
  // version a profile still resolves to). Frees disk without breaking profiles.
  handle('plugins:cleanupVersions', (_event, name: string): IpcResult<PluginCleanupResult> => {
    try {
      if (pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      const store = pluginDir()
      const versions = storeVersions(store, name)
      if (versions.length <= 1) return { ok: true, value: { removed: [] } }
      const used = new Set(
        (buildInstalledOverview(dshScopes(), store).find(r => r.name === name)?.usage ?? [])
          .map(u => u.version)
          .filter((v): v is string => v !== undefined && v !== ''),
      )
      const keep = versions[versions.length - 1]
      const removed: string[] = []
      for (const version of versions) {
        if (version === keep || used.has(version)) continue
        if (removePlugin(store, name, version).ok) removed.push(version)
      }
      return { ok: true, value: { removed } }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Migrate a deprecated plugin to its catalog replacement across every profile
  // that uses it: install the replacement first, then detach the deprecated one.
  // Refused while any using profile runs.
  handle('plugins:migrateReplacement', async (
    _event, name: string, replacement: string,
  ): Promise<IpcResult<PluginMigrationResult>> => {
    try {
      if (pathIdentifierInvalid(name) || pathIdentifierInvalid(replacement)) return fail(E.nameInvalid)
      const store = pluginDir()
      // Resolve the replacement's install spec + real package name from the
      // catalog when possible; otherwise treat the replacement as an npm name.
      let pkgName = replacement
      let spec: string | null = replacement
      try {
        const catalog = await resolveMarket(marketSourceState())
        const entry = catalog.plugins.find(p => p.npm === replacement || p.name === replacement)
        if (entry !== undefined) {
          const resolved = installSpecFor(entry)
          if (resolved !== null) {
            spec = resolved
            pkgName = typeof entry.npm === 'string' && entry.npm !== '' ? entry.npm : entry.name
          }
        }
      } catch { /* offline — fall back to the npm name */ }
      if (pkgName === name) return fail(E.nameInvalid)

      const dshes = dshScopes()
      const usage = buildInstalledOverview(dshes, store).find(r => r.name === name)?.usage ?? []
      if (usage.length === 0) return fail(E.pluginNotInstalled, { name })
      // Refuse while any using profile runs (mutating node_modules under a live run).
      const running = new Set(listRuns().map(r => `${r.dshId}\u0000${r.profile}`))
      const idByName = new Map(dshes.map(d => [d.name, d.id]))
      const active = usage.filter(u => running.has(`${idByName.get(u.dsh) ?? ''}\u0000${u.profile}`))
      if (active.length > 0) return fail(E.runAlreadyRunning, { profile: active.map(u => u.profile).join('、') })

      if (storeVersions(store, pkgName).length === 0) {
        if (spec === null) return fail(E.pluginNotInstalled, { name: replacement })
        const added = await addPlugin(store, spec, pkgName)
        if (!added.ok) return fail(E.storeOperationFailed, { detail: added.text })
      }
      let installed = 0
      for (const u of usage) {
        const dsh = dshes.find(d => d.name === u.dsh)
        if (dsh === undefined) continue
        const res = await installIntoProfile(join(dsh.home, 'profiles'), u.profile, pkgName, store)
        if (res.ok) installed += 1
      }
      const detached = await removePluginFromProfiles(dshes, name)
      return { ok: true, value: { target: pkgName, installed, detached: detached.length } }
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

  // ── download sessions (cancellable, parallel) ─────────────────────────────

  handle('downloads:start', (_event, source: string, name?: string): IpcResult<{ id: string }> => {
    try {
      if (pluginDir() === '') return fail(E.storeNotConfigured)
      return { ok: true, value: { id: startPluginDownload(pluginDir(), source, name) } }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('downloads:list', (): IpcResult<DownloadSessionInfo[]> => {
    try {
      return { ok: true, value: listPluginDownloads() }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('downloads:cancel', (_event, id: string): IpcResult<boolean> => {
    try {
      return { ok: true, value: cancelPluginDownload(id) }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('downloads:cleanup', (): IpcResult<{ removed: string[] }> => {
    try {
      return { ok: true, value: cleanupPluginDownloads(pluginDir()) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Push live session snapshots to every renderer (matched by the shared
  // `downloads:change` channel), mirroring how `run:event` streams output.
  onDownloadsChange((list) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('download:change', list)
    }
  })

  // One-shot terminal-state push per session: the live list drops a settled
  // session, so this is what lets the renderer refresh dependents (a finished
  // dsh install/update) and report a failure that would otherwise vanish with
  // the row.
  onDownloadsSettled((session) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('download:settled', session)
    }
  })
}