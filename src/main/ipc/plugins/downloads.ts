/** Cancellable, parallel download sessions, and the two renderer broadcasts they feed. */

import { BrowserWindow } from 'electron'
import {
  cancelPluginDownload, cleanupPluginDownloads, listPluginDownloads, onDownloadsChange, onDownloadsSettled,
  startPluginDownload,
} from '../../core/store/downloads.ts'
import { pluginDir } from '../../core/profile/appState.ts'
import { fail, failFromError, E } from '../../core/shared/errors.ts'
import { ctxOf } from '../ctxOf.ts'
import { handle } from '../handle.ts'
import type { DownloadSessionInfo, IpcResult } from '../../../shared/types.ts'

export function registerDownloadsIpc(): void {
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
