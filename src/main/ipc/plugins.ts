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
import { linkDevToProfile, repairDevLink } from '../core/profile.ts'
import {
  buildDevPlugin, cachedDiagnosis, defaultDevBuild, devScriptOptions, forgetDevDiagnosis, installDevDeps, listDevPlugins,
  registerDevPlugin, removeDevPlugin, shimDevPeers, unshimDevPeers,
} from '../core/dev-plugins.ts'
import { listProfiles } from '../core/home.ts'
import {
  cancelPluginDownload, cleanupPluginDownloads, listPluginDownloads, onDownloadsChange, onDownloadsSettled, startPluginDownload,
} from '../core/pluginDownloads.ts'
import { checkPluginUpdates } from '../core/plugin-updates.ts'
import { installSpecFor, marketSourceState, resolveMarket } from '../core/market.ts'
import { contextForEntry, dshEntryById, dshScopes, pluginDir, profilesRoot, profilesRootFor, type DshContext } from '../core/appState.ts'
import { isProfileRunning, listRuns } from './run.ts'
import { patchSettings } from '../core/settings.ts'
import { inlineRelativeImages } from '../core/app-util.ts'
import { fetchPackageVersions, npmSearch } from '../core/npm.ts'
import { attachPluginSizes } from '../core/store-overview.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { pathIdentifierInvalid, versionInvalid } from './validate.ts'
import { ctxOf } from './ctxOf.ts'
import { handle } from './handle.ts'
import type { ComboPlugin, DevBuildTarget, DevDiagnoseOptions, DevDiagnosis, DevLinkMode, DevPlugin, DevRunResult, DevScriptOptions, DownloadSessionInfo, InstalledOverviewRow, IpcResult, NpmSearchHit, PackageVersionInfo, PluginApplyResult, PluginApplyTarget, PluginCleanupResult, PluginMigrationResult, PluginUpdateInfo, PluginUpdateResult, PluginUsagePoint } from '../../shared/types.ts'

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

/** Remove a plugin's UNUSED archived versions — keep the newest, plus any version
 * a profile still resolves to. Frees disk without breaking profiles. Shared by
 * the explicit cleanup action and an update's "don't keep the old version". */
function cleanupUnusedVersions(store: string, name: string): string[] {
  const versions = storeVersions(store, name)
  if (versions.length <= 1) return []
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
  return removed
}

/** A context for a dsh-agnostic operation (dev-plugin diagnosis/peers), together
 * with the identity the report's provenance line needs. An explicit id MUST
 * exist: substituting another dsh would diagnose — and shim peers — against a
 * resolution chain the user did not choose. With no id it stays the first
 * registered dsh. `null` when there is none. */
function devHostTarget(dshId: unknown): { ctx: DshContext; id: string; name: string; version: string } | null {
  if (typeof dshId === 'string' && dshId !== '') {
    const entry = dshEntryById(dshId)
    if (entry === undefined) return null
    return { ctx: contextForEntry(entry), id: entry.id, name: entry.name, version: entry.version }
  }
  const scope = dshScopes()[0]
  if (scope === undefined) return null
  const version = scope.version ?? ''
  return {
    ctx: { execPath: scope.execPath ?? '', home: scope.home, version },
    id: scope.id, name: scope.name, version,
  }
}

/** The profile a diagnosis targets, validated: it becomes a path AND its
 * composition decides which ids mean what, so an unknown one is an error rather
 * than a silently profile-less report. `null` = no profile (host layers only). */
function devTargetProfile(ctx: DshContext, raw: unknown): string | null | IpcResult<never> {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string' || pathIdentifierInvalid(raw)) return fail(E.nameInvalid)
  if (!listProfiles(ctx).includes(raw)) return fail(E.profileNotFound, { detail: raw })
  return raw
}

/** Whether `devTargetProfile` refused. */
function profileRefused(pick: string | null | IpcResult<never>): pick is IpcResult<never> {
  return pick !== null && typeof pick !== 'string'
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

  // Apply ONE plugin version to specific profiles (or just archive it when no
  // target is given): downloads once, then re-points each profile's dependency.
  handle('plugins:applyUpdate', async (
    _event, name: string, version: string, targets: { dshId: string; profile: string }[],
    opts?: { keepOld?: boolean },
  ): Promise<IpcResult<PluginUpdateResult>> => {
    try {
      if (pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      if (versionInvalid(version)) return fail(E.nameInvalid)
      if (!Array.isArray(targets)) return fail(E.nameInvalid)
      const store = pluginDir()
      if (store === '') return fail(E.storeNotConfigured)
      let downloaded = false
      if (!storeVersions(store, name).includes(version)) {
        const added = await addPlugin(store, `${name}@${version}`, name)
        if (!added.ok) return fail(E.storeInstallFailed, { detail: added.text })
        downloaded = true
      }
      const results: PluginApplyTarget[] = []
      for (const target of targets) {
        const dshId = typeof target?.dshId === 'string' ? target.dshId : ''
        const profile = typeof target?.profile === 'string' ? target.profile : ''
        const ctx = ctxOf(dshId)
        if (ctx === null) { results.push({ dsh: dshId, profile, ok: false, text: '未找到该 DSH' }); continue }
        if (pathIdentifierInvalid(profile)) { results.push({ dsh: dshId, profile, ok: false, text: 'profile 名不合法' }); continue }
        // Replacing the install under a live runtime breaks it.
        if (isProfileRunning(dshId, profile)) { results.push({ dsh: dshId, profile, ok: false, text: '运行中，已跳过' }); continue }
        const linked = await installIntoProfile(profilesRootFor(ctx), profile, name, store, { version })
        results.push({ dsh: dshId, profile, ok: linked.ok, text: linked.text })
      }
      // Optionally drop the now-unused older versions (newest + in-use are kept).
      const removed = opts?.keepOld === false ? cleanupUnusedVersions(store, name) : []
      return { ok: true, value: { downloaded, results, ...(removed.length > 0 ? { removed } : {}) } }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Garbage-collect a plugin's UNUSED archived versions.
  handle('plugins:cleanupVersions', (_event, name: string): IpcResult<PluginCleanupResult> => {
    try {
      if (pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      return { ok: true, value: { removed: cleanupUnusedVersions(pluginDir(), name) } }
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
        const res = await installIntoProfile(profilesRoot(dsh.home), u.profile, pkgName, store)
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

  // ── dev plugins (local source dirs, linked not archived) ───────────────────

  /** The dev-plugin registry plus where each is used (derived from the overview,
   * so a link that drifted out of a profile shows as unused). */
  handle('plugins:devList', (): IpcResult<{ plugins: DevPlugin[]; usage: Record<string, PluginUsagePoint[]> }> => {
    try {
      const plugins = listDevPlugins()
      const names = new Set(plugins.map(p => p.name))
      const usage: Record<string, PluginUsagePoint[]> = {}
      if (names.size > 0) {
        for (const row of buildInstalledOverview(dshScopes(), pluginDir())) {
          if (names.has(row.name)) usage[row.name] = row.usage
        }
      }
      return { ok: true, value: { plugins, usage } }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Register a source dir as a dev plugin. No copy: the registry only records it.
  handle('plugins:devAdd', async (): Promise<IpcResult<DevPlugin>> => {
    try {
      const picked = await dialog.showOpenDialog({ title: '选择开发插件包目录', properties: ['openDirectory'] })
      if (picked.canceled || picked.filePaths.length === 0) return fail(E.commonCancelled)
      return { ok: true, value: registerDevPlugin(picked.filePaths[0]) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Unregister. Never touches the source dir or any profile.
  handle('plugins:devRemove', (_event, name: string): IpcResult<boolean> => {
    try {
      if (pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      removeDevPlugin(name)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Resolution diagnosis against one target (host + optional profile): the entry
  // build output, the patch rows dsh actually loads — each resolved by its own
  // `name:` or by the package its `id:` is bound to in that composition — and the
  // peers a `link:` must resolve from the dev package itself. Cached; `refresh`
  // recomputes.
  handle('plugins:devDiagnose', (_event, name: string, opts?: DevDiagnoseOptions): IpcResult<DevDiagnosis> => {
    try {
      const dev = listDevPlugins().find(p => p.name === name)
      if (dev === undefined) return fail(E.nameInvalid, [], `未注册的开发插件：${name}`)
      const target = devHostTarget(opts?.dshId)
      if (target === null) return fail(E.dshNotFound)
      const profile = devTargetProfile(target.ctx, opts?.profile)
      if (profileRefused(profile)) return profile
      return {
        ok: true,
        value: cachedDiagnosis(dev, target.ctx, {
          ...(profile !== null ? { profile } : {}),
          refresh: opts?.refresh === true,
          dsh: { id: target.id, name: target.name, version: target.version },
        }),
      }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Fallback peer fix: junction the host's copies into the dev package. Reversible;
  // `pnpm install` in the repo will drop them again.
  handle('plugins:devShimPeers', (_event, name: string, opts?: DevDiagnoseOptions): IpcResult<{ added: string[]; skipped: string[] }> => {
    try {
      const dev = listDevPlugins().find(p => p.name === name)
      if (dev === undefined) return fail(E.nameInvalid, [], `未注册的开发插件：${name}`)
      const target = devHostTarget(opts?.dshId)
      if (target === null) return fail(E.dshNotFound)
      const profile = devTargetProfile(target.ctx, opts?.profile)
      if (profileRefused(profile)) return profile
      return { ok: true, value: shimDevPeers(dev, target.ctx, profile !== null ? { profile } : {}) }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('plugins:devUnshimPeers', (_event, name: string): IpcResult<{ removed: string[] }> => {
    try {
      const dev = listDevPlugins().find(p => p.name === name)
      if (dev === undefined) return fail(E.nameInvalid, [], `未注册的开发插件：${name}`)
      return { ok: true, value: { removed: unshimDevPeers(dev) } }
    } catch (error) {
      return failFromError(error)
    }
  })

  // The build scripts a dev plugin can run (its own + its workspace root's).
  handle('plugins:devScripts', (_event, name: string): IpcResult<{ options: DevScriptOptions; current?: DevBuildTarget }> => {
    try {
      const dev = listDevPlugins().find(p => p.name === name)
      if (dev === undefined) return fail(E.nameInvalid, [], `未注册的开发插件：${name}`)
      const current = dev.build ?? defaultDevBuild(dev)
      return { ok: true, value: { options: devScriptOptions(dev), ...(current !== undefined ? { current } : {}) } }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Run a build script (the remembered/default target unless one is given).
  handle('plugins:devBuild', async (_event, name: string, target?: DevBuildTarget): Promise<IpcResult<DevRunResult>> => {
    try {
      const dev = listDevPlugins().find(p => p.name === name)
      if (dev === undefined) return fail(E.nameInvalid, [], `未注册的开发插件：${name}`)
      let chosen: DevBuildTarget | undefined
      if (target !== undefined) {
        const script = typeof target.script === 'string' ? target.script.trim() : ''
        if (!/^[A-Za-z0-9:_-]+$/.test(script)) return fail(E.nameInvalid)
        chosen = { script, scope: target.scope === 'workspace' ? 'workspace' : 'package' }
      }
      return { ok: true, value: await buildDevPlugin(dev, chosen) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Install the dev package's own deps (durable peer fix; prefers its workspace).
  handle('plugins:devInstall', async (_event, name: string): Promise<IpcResult<DevRunResult>> => {
    try {
      const dev = listDevPlugins().find(p => p.name === name)
      if (dev === undefined) return fail(E.nameInvalid, [], `未注册的开发插件：${name}`)
      return { ok: true, value: await installDevDeps(dev) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Attach a dev plugin to a profile: `link` (live, edits picked up) or `copy`
  // (snapshot into the store, then real-install a fixed version).
  handle('plugins:devLinkToProfile', async (_event, dshId: string, profile: string, name: string, mode: DevLinkMode): Promise<IpcResult<string>> => {
    try {
      const ctx = ctxOf(dshId)
      if (ctx === null) return fail(E.dshNotFound)
      if (pathIdentifierInvalid(profile) || pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      if (isProfileRunning(dshId, profile)) return fail(E.runAlreadyRunning, { profile })
      const dev = listDevPlugins().find(p => p.name === name)
      if (dev === undefined) return fail(E.nameInvalid, [], `未注册的开发插件：${name}`)
      if (mode === 'copy') {
        const store = pluginDir()
        if (store === '') return fail(E.storeNotConfigured)
        const snap = await addLocalPlugin(store, dev.dir)
        if (!snap.ok) return fail(E.storeInstallFailed, { detail: snap.text })
        const version = storeVersions(store, name).at(-1)
        const linked = await installIntoProfile(profilesRootFor(ctx), profile, name, store, version !== undefined ? { version } : {})
        if (!linked.ok) return fail(E.storeOperationFailed, { detail: linked.text })
        forgetDevDiagnosis()
        return { ok: true, value: linked.text }
      }
      const result = await linkDevToProfile(ctx, profile, name, dev.dir)
      if (!result.ok) return fail(E.storeOperationFailed, { detail: result.text })
      forgetDevDiagnosis()
      return { ok: true, value: result.text }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('plugins:devRepairLink', async (_event, dshId: string, profile: string, name: string, opts?: { inSource?: boolean }): Promise<IpcResult<string>> => {
    try {
      const ctx = ctxOf(dshId)
      if (ctx === null) return fail(E.dshNotFound)
      if (pathIdentifierInvalid(profile) || pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      if (isProfileRunning(dshId, profile)) return fail(E.runAlreadyRunning, { profile })
      const result = await repairDevLink(ctx, profile, name, opts ?? {})
      if (!result.ok) return fail(E.storeOperationFailed, { detail: result.text })
      forgetDevDiagnosis()
      return { ok: true, value: result.text }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Graduate: archive the current source state into the store as a version, so
  // it can be pinned/version-managed like a normal plugin.
  handle('plugins:devSnapshot', async (_event, name: string): Promise<IpcResult<string>> => {
    try {
      const dev = listDevPlugins().find(p => p.name === name)
      if (dev === undefined) return fail(E.nameInvalid, [], `未注册的开发插件：${name}`)
      const store = pluginDir()
      if (store === '') return fail(E.storeNotConfigured)
      const result = await addLocalPlugin(store, dev.dir)
      return result.ok ? { ok: true, value: result.text } : fail(E.storeInstallFailed, { detail: result.text })
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('plugins:devReveal', async (_event, name: string): Promise<IpcResult<boolean>> => {
    try {
      const dev = listDevPlugins().find(p => p.name === name)
      if (dev === undefined) return fail(E.nameInvalid, [], `未注册的开发插件：${name}`)
      const error = await shell.openPath(dev.dir)
      return error === '' ? { ok: true, value: true } : fail(E.shellOpenPath, { detail: error })
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('plugins:devRevealWorkspace', async (_event, name: string): Promise<IpcResult<boolean>> => {
    try {
      const dev = listDevPlugins().find(p => p.name === name)
      if (dev === undefined) return fail(E.nameInvalid, [], `未注册的开发插件：${name}`)
      const error = await shell.openPath(dev.workspaceRoot ?? dev.dir)
      return error === '' ? { ok: true, value: true } : fail(E.shellOpenPath, { detail: error })
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