/** Window-control IPC (`window:*`) for the frameless custom title bar:
 * minimize / maximize-toggle / close / is-maximized, plus a push event that
 * mirrors the maximize state so the renderer can switch its icon. */

import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '../../shared/types.ts'

/** Resolve the window this message came from (fallbacks for safety). */
function windowFrom(event: IpcMainInvokeEvent | IpcMainEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender)
    ?? BrowserWindow.getFocusedWindow()
    ?? BrowserWindow.getAllWindows()[0]
}

/** Mirror `maximize` / `unmaximize` to the renderer's title bar. Call once per
 * window at creation (the renderer subscribes to `window:maximized`). */
export function hookWindowMaximize(win: BrowserWindow): void {
  const push = (maximized: boolean): void => {
    if (!win.isDestroyed()) win.webContents.send('window:maximized', maximized)
  }
  win.on('maximize', () => push(true))
  win.on('unmaximize', () => push(false))
}

export function registerWindowIpc(): void {
  ipcMain.handle('window:minimize', (event): IpcResult<boolean> => {
    const w = windowFrom(event)
    if (w === undefined) return { ok: false, code: 'window.notFound', error: 'no window' }
    w.minimize()
    return { ok: true, value: true }
  })

  ipcMain.handle('window:toggleMaximize', (event): IpcResult<boolean> => {
    const w = windowFrom(event)
    if (w === undefined) return { ok: false, code: 'window.notFound', error: 'no window' }
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
    return { ok: true, value: true }
  })

  ipcMain.handle('window:close', (event): IpcResult<boolean> => {
    const w = windowFrom(event)
    if (w === undefined) return { ok: false, code: 'window.notFound', error: 'no window' }
    // Goes through the existing `close` guard (asks before killing a profile run).
    w.close()
    return { ok: true, value: true }
  })

  ipcMain.handle('window:quit', (): IpcResult<boolean> => {
    // Hard quit — bypasses the minimize-to-tray close guard (used for the
    // "exit" choice on the store-migration consent dialog).
    app.quit()
    return { ok: true, value: true }
  })

  ipcMain.handle('window:isMaximized', (event): IpcResult<boolean> => {
    const w = windowFrom(event)
    if (w === undefined) return { ok: false, code: 'window.notFound', error: 'no window' }
    return { ok: true, value: w.isMaximized() }
  })
}