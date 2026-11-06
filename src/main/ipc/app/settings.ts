/** IPC for app-level UI preferences + the first-run onboarding wizard
 * (`settings:*`). */

import { app, dialog } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  askOnCloseEnabled, closeToTrayEnabled, exportSettings, importSettings, loadSettings, patchSettings,
} from '../../core/settings/settings.ts'
import {
  dataRoot, dshVersionDir, pluginDir, readDshState, shouldRunOnboarding, skillLibraryDir,
} from '../../core/profile/appState.ts'
import { fail, failFromError, E } from '../../core/shared/errors.ts'
import { dialogFilter, dialogTitle } from '../../core/shared/dialog-text.ts'
import { handle } from '../handle.ts'
import { checkHealth } from '../../core/dsh/health.ts'
import { checkAppUpdate } from '../../core/github/updates.ts'
import { githubAuthState, probeGithubRateLimit, setGithubToken } from '../../core/github/auth.ts'
import { nodeEnvironment } from '../../core/dsh/node-env.ts'
import { nodePreferenceValue } from '../../core/settings/settings.ts'
import { applyDataRoot } from './data-root.ts'
import { normalizeScope, parseRegistry } from '../../core/store/npmrc.ts'
import { registryEntryViews, setRegistryToken } from '../../core/store/registry-auth.ts'
import { probeRegistry } from '../../core/store/npm.ts'
import type { RegistryEntryRecord } from '../../core/settings/normalize.ts'
import type {
  AppUpdateInfo, GithubAuthState, GithubRateLimit, HealthIssue, IpcResult, NodeEnvironment, OnboardingPayload,
  OnboardingState, RegistryEntryInput, RegistryEntryView, RegistryProbe,
} from '../../../shared/types.ts'

export function registerSettingsIpc(): void {
  handle('settings:getUiLanguage', (): IpcResult<string | null> => {
    try {
      return { ok: true, value: loadSettings().uiLanguage ?? null }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('settings:setUiLanguage', (_event, lng: string): IpcResult<boolean> => {
    try {
      patchSettings({ uiLanguage: lng })
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('settings:getCloseToTray', (): IpcResult<boolean> => {
    try {
      return { ok: true, value: closeToTrayEnabled() }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('settings:setCloseToTray', (_event, enabled: boolean): IpcResult<boolean> => {
    try {
      patchSettings({ closeToTray: enabled })
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('settings:getAskOnClose', (): IpcResult<boolean> => {
    try {
      return { ok: true, value: askOnCloseEnabled() }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('settings:setAskOnClose', (_event, enabled: boolean): IpcResult<boolean> => {
    try {
      patchSettings({ askOnClose: enabled })
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Bundled / system Node detection + which one dsh launches with. */
  handle('settings:getNodeEnvironment', (): IpcResult<NodeEnvironment> => {
    try {
      return { ok: true, value: nodeEnvironment(nodePreferenceValue()) }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Persist the preferred node for launching dsh (`'system'` | `'bundled'`). */
  handle('settings:setNodePreference', (_event, preference: 'system' | 'bundled'): IpcResult<boolean> => {
    try {
      const value = preference === 'bundled' ? 'bundled' : 'system'
      patchSettings({ nodePreference: value })
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** GitHub API auth for update detection: token source / encryption / rate limit. */
  handle('settings:getGithubAuth', (): IpcResult<GithubAuthState> => {
    try {
      return { ok: true, value: githubAuthState() }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Save (or clear, with `''`) the GitHub token; returns the new state. */
  handle('settings:setGithubToken', (_event, value: string | null): IpcResult<GithubAuthState> => {
    try {
      return { ok: true, value: setGithubToken(typeof value === 'string' ? value : null) }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Probe the live GitHub rate limit with the current token (Settings test). */
  handle('settings:testGithubToken', async (): Promise<IpcResult<GithubRateLimit>> => {
    try {
      return { ok: true, value: await probeGithubRateLimit() }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** The configured registries, as the settings editor renders them: no token
   * values, only whether each entry has one and how it is protected. */
  handle('settings:listRegistries', (): IpcResult<RegistryEntryView[]> => {
    try {
      return { ok: true, value: registryEntryViews() }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Add or update one registry. Validated at the boundary: these strings become
   * request URLs and pnpm configuration, so a bad value is refused here rather
   * than warned about at the first lookup.
   *
   * Two rules are enforced because routing depends on them: scopes must be
   * unique (case-insensitively), and at most one entry may have no scope — two
   * of those would be two answers to the same question. */
  handle('settings:saveRegistry', (_event, input: RegistryEntryInput): IpcResult<RegistryEntryView[]> => {
    try {
      const rawUrl = typeof input?.url === 'string' ? input.url.trim() : ''
      const url = parseRegistry(rawUrl)
      if (url === undefined) {
        // Distinguish "not a URL" from "not http(s)": the two have different
        // fixes, and `apiErrorText` prefers the localized message either way.
        let parsed: URL | undefined
        try { parsed = new URL(rawUrl) } catch { parsed = undefined }
        return parsed === undefined
          ? fail(E.registryBadUrl, { detail: rawUrl })
          : fail(E.registryBadScheme, { detail: rawUrl })
      }
      // One registry may own several scopes; at least one is required, because an
      // entry with none owns no package at all.
      const catchAll = input.catchAll === true
      const rawScopes: unknown[] = Array.isArray(input.scopes) ? input.scopes : []
      const scopes: string[] = []
      for (const value of rawScopes) {
        const raw = typeof value === 'string' ? value.trim() : ''
        if (raw === '') continue
        const scope = normalizeScope(raw)
        if (scope === undefined) return fail(E.registryBadScope, { detail: raw })
        if (!scopes.some(existing => existing.toLowerCase() === scope.toLowerCase())) scopes.push(scope)
      }
      // Mirror mode and scopes are mutually exclusive: a scope that would be
      // ignored is the silent inconsistency this model exists to prevent.
      if (catchAll && scopes.length > 0) return fail(E.registryModeConflict)
      if (!catchAll && scopes.length === 0) return fail(E.registryScopeRequired)

      const list = [...(loadSettings().registries ?? [])]
      const id = typeof input.id === 'string' && input.id !== '' ? input.id : `reg-${randomUUID().slice(0, 8)}`
      const others = list.filter(entry => entry.id !== id)
      if (catchAll && others.some(entry => entry.catchAll === true)) {
        return fail(E.registryDuplicateMirror)
      }
      for (const scope of scopes) {
        const taken = others.some(entry =>
          (entry.scopes ?? []).some(existing => existing.toLowerCase() === scope.toLowerCase()))
        if (taken) return fail(E.registryDuplicateScope, { detail: scope })
      }

      const label = typeof input.label === 'string' && input.label.trim() !== ''
        ? input.label.trim()
        : (() => { try { return new URL(url).host } catch { return url } })()
      const existing = list.find(entry => entry.id === id)
      const entry: RegistryEntryRecord = {
        id,
        label,
        url,
        scopes,
        ...(catchAll ? { catchAll: true } : {}),
        ...(existing?.tokenEnc !== undefined ? { tokenEnc: existing.tokenEnc } : {}),
      }
      const next = existing === undefined
        ? [...list, entry]
        : list.map(e => (e.id === id ? entry : e))
      patchSettings({ registries: next })

      // Tri-state: absent leaves the saved token alone (editing a label must not
      // wipe a credential), `''` clears it, anything else replaces it.
      if (typeof input.token === 'string') setRegistryToken(id, input.token)
      return { ok: true, value: registryEntryViews() }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Drop one registry. Its token goes with it. */
  handle('settings:removeRegistry', (_event, id: string): IpcResult<RegistryEntryView[]> => {
    try {
      const list = loadSettings().registries ?? []
      if (!list.some(entry => entry.id === id)) return fail(E.registryEntryMissing)
      patchSettings({ registries: list.filter(entry => entry.id !== id) })
      return { ok: true, value: registryEntryViews() }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Reach one registry (or the fallback one) once, so an address and a token can
   * be checked before they are trusted with an install. */
  handle('settings:testRegistry', async (_event, id?: string): Promise<IpcResult<RegistryProbe>> => {
    try {
      return { ok: true, value: await probeRegistry(typeof id === 'string' && id !== '' ? id : undefined) }
    } catch (error) {
      return failFromError(error)
    }
  })
  handle('settings:getOnboardingState', (): IpcResult<OnboardingState> => {    try {
      return {
        ok: true,
        value: {
          required: shouldRunOnboarding(),
          defaults: {
            dataRoot: dataRoot(),
            derived: { plugins: pluginDir(), skillLibrary: skillLibraryDir(), dshVersions: dshVersionDir() },
          },
        },
      }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Let the renderer ask for a folder via the native picker (create-allowed).
   * Returns the chosen path, or `''` when cancelled. */
  handle('settings:pickDir', async (_event, opts: { title?: string; defaultPath?: string } = {}): Promise<IpcResult<string>> => {
    try {
      const picked = await dialog.showOpenDialog({
        title: opts.title,
        defaultPath: opts.defaultPath,
        properties: ['openDirectory', 'createDirectory'],
      })
      return { ok: true, value: picked.canceled ? '' : picked.filePaths[0] ?? '' }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Persist the wizard's choices and mark onboarding complete. The directory
   * rules are the data root's own (`applyDataRoot`), so the wizard and the
   * settings page cannot drift apart. A fresh install has nothing to migrate. */
  handle('settings:completeOnboarding', async (_event, payload: OnboardingPayload): Promise<IpcResult<boolean>> => {
    try {
      const { uiLanguage, dataRoot: root, nodePreference } = payload ?? {}
      if (typeof root === 'string' && root.trim() !== '') {
        const res = await applyDataRoot(root, { migrate: false })
        if (!res.ok) return res
      }
      patchSettings({
        ...(typeof uiLanguage === 'string' && uiLanguage.trim() !== ''
          ? { uiLanguage: uiLanguage.trim() }
          : {}),
        ...(nodePreference === 'system' || nodePreference === 'bundled' ? { nodePreference } : {}),
        onboarded: true,
      })
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Path health: does what the app recorded still exist on disk (dsh executables,
   * store dir, store plugins)? Drives the top "disk vs. app" sync banner. */
  handle('settings:checkHealth', (): IpcResult<HealthIssue[]> => {
    try {
      return { ok: true, value: checkHealth(readDshState().dshes, pluginDir()) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // The packaged app version, for the About page.
  handle('app:version', (): IpcResult<string> => {
    try {
      return { ok: true, value: app.getVersion() }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Whether a newer launcher release exists on GitHub (About page). Network/API
  // failures surface as a retryable error, not a wrong "up to date".
  handle('app:checkUpdate', async (): Promise<IpcResult<AppUpdateInfo>> => {
    try {
      return { ok: true, value: await checkAppUpdate(app.getVersion()) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // ── settings backup / restore ───────────────────────────────────────────────

  /** Export the settings to a user-chosen JSON file. `''` = cancelled. */
  handle('settings:export', async (): Promise<IpcResult<string>> => {
    try {
      const picked = await dialog.showSaveDialog({
        title: dialogTitle('exportSettings'),
        defaultPath: 'dsh-launcher-settings.json',
        filters: [dialogFilter('exportSettings', ['json'])],
      })
      if (picked.canceled || picked.filePath === '') return { ok: true, value: '' }
      writeFileSync(picked.filePath, exportSettings())
      return { ok: true, value: picked.filePath }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Import settings from a JSON file. `false` = cancelled. */
  handle('settings:import', async (): Promise<IpcResult<boolean>> => {
    try {
      const picked = await dialog.showOpenDialog({
        title: dialogTitle('importSettings'),
        properties: ['openFile'],
        filters: [dialogFilter('importSettings', ['json'])],
      })
      if (picked.canceled || picked.filePaths.length === 0) return { ok: true, value: false }
      importSettings(readFileSync(picked.filePaths[0], 'utf8'))
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })
}
