/** IPC for app-level UI preferences (`settings:*`). */

import { ipcMain } from 'electron'
import { loadSettings, saveSettings } from '../core/settings.ts'
import { failFromError } from '../core/errors.ts'
import type { IpcResult } from '../../shared/types.ts'

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
}