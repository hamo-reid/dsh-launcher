/** IPC for app-level UI preferences + the first-run onboarding wizard
 * (`settings:*`). */

import { ipcMain, dialog } from 'electron'
import { loadSettings, saveSettings } from '../core/settings.ts'
import { dshVersionDir, pluginDir, readDshState, shouldRunOnboarding } from '../core/appState.ts'
import { failFromError } from '../core/errors.ts'
import { checkHealth } from '../core/health.ts'
import { setPluginStoreDir } from './plugins.ts'
import { setVersionDirValue } from './dsh.ts'
import type { HealthIssue, IpcResult, OnboardingPayload, OnboardingState } from '../../shared/types.ts'

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:getUiLanguage', (): IpcResult<string | null> => {
    try {
      return { ok: true, value: loadSettings().uiLanguage ?? null }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('settings:setUiLanguage', (_event, lng: string): IpcResult<boolean> => {
    try {
      saveSettings({ ...loadSettings(), uiLanguage: lng })
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('settings:getOnboardingState', (): IpcResult<OnboardingState> => {
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
  ipcMain.handle('settings:pickDir', async (_event, opts: { title?: string; defaultPath?: string } = {}): Promise<IpcResult<string>> => {
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
  ipcMain.handle('settings:completeOnboarding', (_event, payload: OnboardingPayload): IpcResult<boolean> => {
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
      saveSettings({
        ...loadSettings(),
        ...(typeof uiLanguage === 'string' && uiLanguage.trim() !== ''
          ? { uiLanguage: uiLanguage.trim() }
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
  ipcMain.handle('settings:checkHealth', (): IpcResult<HealthIssue[]> => {
    try {
      return { ok: true, value: checkHealth(readDshState().dshes, pluginDir()) }
    } catch (error) {
      return failFromError(error)
    }
  })
}