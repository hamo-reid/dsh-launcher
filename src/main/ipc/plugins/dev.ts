/** Dev plugins: local source dirs linked into profiles rather than
 * archived, and the diagnosis that explains what resolution is missing. */

import { dialog, shell } from 'electron'
import { resolve } from 'node:path'
import { addLocalPlugin, buildInstalledOverview, installIntoProfile, storeVersions } from '../../core/store/plugins.ts'
import { linkDevToProfile, repairDevLink } from '../../core/profile/profile.ts'
import {
  buildDevPlugin, cachedDiagnosis, defaultDevBuild, devScriptOptions, forgetDevDiagnosis, installDevDeps,
  listDevPlugins, registerDevPlugin, removeDevPlugin, shimDevPeers, unshimDevPeers,
} from '../../core/store/dev.ts'
import { listProfiles } from '../../core/profile/home.ts'
import {
  contextForEntry, dshEntryById, dshScopes, pluginDir, profilesRootFor, type DshContext,
} from '../../core/profile/appState.ts'
import { isProfileRunning } from '../dsh/run.ts'
import { fail, failFromError, E } from '../../core/shared/errors.ts'
import { pathIdentifierInvalid } from '../validate.ts'
import { ctxOf } from '../ctxOf.ts'
import { handle } from '../handle.ts'
import type {
  DevBuildTarget, DevDiagnoseOptions, DevDiagnosis, DevLinkMode, DevPlugin, DevRunResult, DevScriptOptions, IpcResult,
  PluginUsagePoint,
} from '../../../shared/types.ts'

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

export function registerDevIpc(): void {
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

}
