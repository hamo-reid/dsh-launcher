/** IPC for the plugin store (`plugins:*`): store dir, network/local downloads,
 * install-into-profile, search, overview, README and reveal. */

import { BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  addLocalPlugin, addPlugin, buildInstalledOverview, findInstalledDir, initStore, installIntoProfile, listPlugins,
  listProfileScopes, readPluginReadme, removePlugin, removePluginFromProfiles,
} from '../core/plugins.ts'
import { listComboPlugins } from '../core/combo.ts'
import {
  cancelPluginDownload, cleanupPluginDownloads, listPluginDownloads, onDownloadsChange, startPluginDownload,
} from '../core/pluginDownloads.ts'
import { dshScopes, pluginDir, readDshState } from '../core/appState.ts'
import { loadSettings, saveSettings } from '../core/settings.ts'
import { inlineRelativeImages } from '../core/app-util.ts'
import { fetchPackageVersions, npmSearch } from '../core/npm.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { pathIdentifierInvalid, versionInvalid } from './validate.ts'
import type { ComboPlugin, DownloadSessionInfo, InstalledOverviewRow, IpcResult, NpmSearchHit, PackageVersionInfo, PluginUsagePoint } from '../../shared/types.ts'

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
    saveSettings({ ...loadSettings(), pluginDir: target })
    return { ok: true, value: true }
  } catch (error) {
    return fail(E.storeUnusable, { detail: String(error) })
  }
}

export function registerPluginsIpc(): void {
  ipcMain.handle('plugins:getDir', (): IpcResult<{ dir: string }> => {
    try {
      return { ok: true, value: { dir: pluginDir() } }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('plugins:setDir', (_event, dir: string): IpcResult<boolean> =>
    setPluginStoreDir(dir))

  ipcMain.handle('plugins:list', async (): Promise<IpcResult<{ name: string; version: string }[]>> => {
    try {
      return { ok: true, value: listPlugins(pluginDir()) }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('plugins:add', async (_event, source: string, name?: string): Promise<IpcResult<string>> => {
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
  ipcMain.handle('plugins:addLocal', async (_event, kind: 'folder' | 'zip'): Promise<IpcResult<string>> => {
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
  ipcMain.handle('plugins:installOptions', (): IpcResult<{ id: string; name: string; version?: string; profiles: string[] }[]> => {
    try {
      return { ok: true, value: listProfileScopes(dshScopes()) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Point a profile (under a chosen dsh) at a locally-downloaded plugin.
  ipcMain.handle('plugins:installToProfile', async (_event, profile: string, pkg: string, version?: string, dshId?: string): Promise<IpcResult<string>> => {
    try {
      if (pathIdentifierInvalid(profile) || pathIdentifierInvalid(pkg)) return fail(E.nameInvalid)
      if (version !== undefined && versionInvalid(version)) return fail(E.nameInvalid)
      const entry = dshId !== undefined ? readDshState().dshes.find(d => d.id === dshId) : undefined
      const base = entry !== undefined && entry.profilesDir !== undefined
        ? entry.profilesDir
        : entry !== undefined ? join(entry.home, 'profiles') : undefined
      const result = await installIntoProfile(profile, pkg, pluginDir(), base, { version })
      return result.ok ? { ok: true, value: result.text } : fail(E.storeOperationFailed, { detail: result.text })
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('plugins:remove', async (_event, name: string, version?: string): Promise<IpcResult<string>> => {
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
  ipcMain.handle('plugins:uninstall', async (_event, name: string): Promise<IpcResult<{ removed: PluginUsagePoint[] }>> => {
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

  ipcMain.handle('plugins:search', async (_event, query: string, opts?: { from?: number; size?: number }): Promise<IpcResult<{ hits: NpmSearchHit[]; total: number }>> => {
    try {
      return { ok: true, value: await npmSearch(query, opts) }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('plugins:pkgVersions', async (_event, name: string): Promise<IpcResult<PackageVersionInfo>> => {
    try {
      if (pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      return { ok: true, value: await fetchPackageVersions(name) }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('plugins:listCombo', (_event, profile: string): IpcResult<ComboPlugin[]> => {
    try {
      return { ok: true, value: listComboPlugins(profile) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Installed-plugin overview: usage across DSH/profiles + store flag.
  ipcMain.handle('plugins:overview', (): IpcResult<InstalledOverviewRow[]> => {
    try {
      return { ok: true, value: buildInstalledOverview(dshScopes(), pluginDir()) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Read a plugin's README markdown for display. Relative image paths are inlined
  // to data: URLs so they load in both dev (http) and packaged (file) renderers.
  ipcMain.handle('plugins:readme', (_event, name: string): IpcResult<{ content: string; dir: string }> => {
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
  ipcMain.handle('plugins:reveal', (_event, name: string): IpcResult<boolean> => {
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

  ipcMain.handle('downloads:start', (_event, source: string, name?: string): IpcResult<{ id: string }> => {
    try {
      if (pluginDir() === '') return fail(E.storeNotConfigured)
      return { ok: true, value: { id: startPluginDownload(pluginDir(), source, name) } }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('downloads:list', (): IpcResult<DownloadSessionInfo[]> => {
    try {
      return { ok: true, value: listPluginDownloads() }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('downloads:cancel', (_event, id: string): IpcResult<boolean> => {
    try {
      return { ok: true, value: cancelPluginDownload(id) }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('downloads:cleanup', (): IpcResult<{ removed: string[] }> => {
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
}