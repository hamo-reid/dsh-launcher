/** IPC for app-level UI preferences + the first-run onboarding wizard
 * (`settings:*`). */

import { app, dialog } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  askOnCloseEnabled, closeToTrayEnabled, exportSettings, importSettings, loadSettings, patchSettings,
} from '../core/settings.ts'
import { dshVersionDir, pluginDir, readDshState, shouldRunOnboarding } from '../core/appState.ts'
import { failFromError } from '../core/errors.ts'
import { handle } from './handle.ts'
import { checkHealth } from '../core/health.ts'
import { checkAppUpdate } from '../core/github-updates.ts'
import { githubAuthState, probeGithubRateLimit, setGithubToken } from '../core/github-auth.ts'
import { nodeEnvironment } from '../core/node-env.ts'
import { nodePreferenceValue } from '../core/settings.ts'
import { setPluginStoreDir } from './plugins.ts'
import { setVersionDirValue } from './dsh.ts'
import type { AppUpdateInfo, GithubAuthState, GithubRateLimit, HealthIssue, IpcResult, NodeEnvironment, OnboardingPayload, OnboardingState } from '../../shared/types.ts'

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

  handle('settings:getOnboardingState', (): IpcResult<OnboardingState> => {
    try {
      return {
        ok: true,
        value: {
          required: shouldRunOnboarding(),
          defaults: { pluginDir: pluginDir(), dshVersionDir: dshVersionDir() },
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

  /** Persist the wizard's choices and mark onboarding complete. Reuses the same
   * directory-save rules as the settings page (`plugins:setDir` / `dsh:setVersionDir`). */
  handle('settings:completeOnboarding', (_event, payload: OnboardingPayload): IpcResult<boolean> => {
    try {
      const { uiLanguage, pluginDir, dshVersionDir } = payload ?? {}
      if (typeof pluginDir === 'string' && pluginDir.trim() !== '') {
        const res = setPluginStoreDir(pluginDir)
        if (!res.ok) return res
      }
      if (typeof dshVersionDir === 'string') {
        const res = setVersionDirValue(dshVersionDir)
        if (!res.ok) return res
      }
      patchSettings({
        ...(typeof uiLanguage === 'string' && uiLanguage.trim() !== ''
          ? { uiLanguage: uiLanguage.trim() }
          : {}),
        ...(payload.nodePreference === 'system' || payload.nodePreference === 'bundled'
          ? { nodePreference: payload.nodePreference }
          : {}),
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
        title: '导出设置',
        defaultPath: 'dsh-launcher-settings.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
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
        title: '导入设置',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (picked.canceled || picked.filePaths.length === 0) return { ok: true, value: false }
      importSettings(readFileSync(picked.filePaths[0], 'utf8'))
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })
}