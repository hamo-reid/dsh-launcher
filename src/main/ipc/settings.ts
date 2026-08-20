/** IPC for app-level UI preferences + the first-run onboarding wizard
 * (`settings:*`). */

import { app, ipcMain, dialog } from 'electron'
import { askOnCloseEnabled, closeToTrayEnabled, loadSettings, saveSettings } from '../core/settings.ts'
import { dshVersionDir, pluginDir, readDshState, shouldRunOnboarding } from '../core/appState.ts'
import { failFromError } from '../core/errors.ts'
import { checkHealth } from '../core/health.ts'
import { nodeEnvironment } from '../core/node-env.ts'
import { nodePreferenceValue } from '../core/settings.ts'
import { setPluginStoreDir } from './plugins.ts'
import { setVersionDirValue } from './dsh.ts'
import type { HealthIssue, IpcResult, NodeEnvironment, OnboardingPayload, OnboardingState } from '../../shared/types.ts'

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

  ipcMain.handle('settings:getCloseToTray', (): IpcResult<boolean> => {
    try {
      return { ok: true, value: closeToTrayEnabled() }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('settings:setCloseToTray', (_event, enabled: boolean): IpcResult<boolean> => {
    try {
      saveSettings({ ...loadSettings(), closeToTray: enabled })
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('settings:getAskOnClose', (): IpcResult<boolean> => {
    try {
      return { ok: true, value: askOnCloseEnabled() }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('settings:setAskOnClose', (_event, enabled: boolean): IpcResult<boolean> => {
    try {
      saveSettings({ ...loadSettings(), askOnClose: enabled })
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Bundled / system Node detection + which one dsh launches with. */
  ipcMain.handle('settings:getNodeEnvironment', (): IpcResult<NodeEnvironment> => {
    try {
      return { ok: true, value: nodeEnvironment(nodePreferenceValue()) }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Persist the preferred node for launching dsh (`'system'` | `'bundled'`). */
  ipcMain.handle('settings:setNodePreference', (_event, preference: 'system' | 'bundled'): IpcResult<boolean> => {
    try {
      const value = preference === 'bundled' ? 'bundled' : 'system'
      saveSettings({ ...loadSettings(), nodePreference: value })
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
  ipcMain.handle('settings:checkHealth', (): IpcResult<HealthIssue[]> => {
    try {
      return { ok: true, value: checkHealth(readDshState().dshes, pluginDir()) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // The packaged app version, for the About page.
  ipcMain.handle('app:version', (): IpcResult<string> => {
    try {
      return { ok: true, value: app.getVersion() }
    } catch (error) {
      return failFromError(error)
    }
  })
}