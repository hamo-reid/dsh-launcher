/** Update detection and application, plus the archived-version cleanup they share. */

import { join } from 'node:path'
import {
  addPlugin, buildInstalledOverview, installIntoProfile, removePlugin, removePluginFromProfiles, storeVersions,
} from '../../core/store/plugins.ts'
import { checkPluginUpdates } from '../../core/store/updates.ts'
import { installSpecFor, marketSourceState, resolveMarket } from '../../core/store/market.ts'
import { dshScopes, pluginDir, profilesRoot, profilesRootFor } from '../../core/profile/appState.ts'
import { isProfileRunning, listRuns } from '../dsh/run.ts'
import { fail, failFromError, E } from '../../core/shared/errors.ts'
import { pathIdentifierInvalid, versionInvalid } from '../validate.ts'
import { ctxOf } from '../ctxOf.ts'
import { handle } from '../handle.ts'
import type {
  IpcResult, PluginApplyResult, PluginApplyTarget, PluginCleanupResult, PluginMigrationResult, PluginUpdateInfo,
  PluginUpdateResult,
} from '../../../shared/types.ts'

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

export function registerUpdatesIpc(): void {
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

}
