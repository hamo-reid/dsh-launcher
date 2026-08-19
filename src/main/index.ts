/** Main process: window lifecycle + IPC wiring. Every handler lives in its own
 * domain module under `src/main/ipc/`; this file only assembles them. */

import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'node:path'
import os from 'node:os'
import { currentRun, registerRunIpc, terminateAndClear } from './ipc/run.ts'
import { registerProfileIpc } from './ipc/profile.ts'
import { registerHomeIpc } from './ipc/home.ts'
import { registerPluginsIpc } from './ipc/plugins.ts'
import { registerDshIpc } from './ipc/dsh.ts'
import { registerTrashIpc } from './ipc/trash.ts'
import { registerSettingsIpc } from './ipc/settings.ts'
import { hookWindowMaximize, registerWindowIpc } from './ipc/window.ts'
import { registerLogsIpc } from './ipc/logs.ts'
import { initLogger, logger } from './core/logger.ts'
import { openDatabase } from './core/settings.ts'
import { configureAppState } from './core/appState.ts'

// Process-level breadcrumbs for anything that escapes the IPC try/catch.
process.on('uncaughtException', (error) => logger.error('uncaughtException', error))
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', reason))

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    title: 'DSH Launcher',
    // Frameless: the renderer provides its own title bar (brand + window controls).
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  hookWindowMaximize(win)

  // Guard exit while a profile process is still running: ask first, and only
  // terminate if the user chooses to.
  let allowClose = false
  win.on('close', (event) => {
    if (allowClose) return
    const active = currentRun()
    if (active === null) return
    event.preventDefault()
    void dialog.showMessageBox(win, {
      type: 'warning',
      title: '进程仍在运行',
      message: `profile「${active.profile}」的 dsh 仍在运行`,
      detail: '退出将终止该进程。选择「取消」可保持其运行。',
      buttons: ['终止并退出', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response !== 0) return
      terminateAndClear(active.child)
      allowClose = true
      win.close()
    })
  })

  if (process.env['ELECTRON_RENDERER_URL'] !== undefined) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  registerRunIpc()
  registerProfileIpc()
  registerHomeIpc()
  registerPluginsIpc()
  registerDshIpc()
  registerTrashIpc()
  registerSettingsIpc()
  registerWindowIpc()
  registerLogsIpc()
}

app.whenReady().then(async () => {
  // 统一默认数据目录到用户主目录下，避免 %APPDATA% 长路径。
  app.setPath('userData', join(os.homedir(), 'dsh-launcher'))

  // 数据目录确定后立即初始化日志，早于任何业务/数据库工作。
  initLogger(join(app.getPath('userData'), 'logs'))
  logger.info('app starting', { version: app.getVersion() != null ? `v${app.getVersion()}` : '' })

  // Open the SQLite settings database before any IPC touches it.
  await openDatabase(join(app.getPath('userData'), 'app.sqlite'))
  // Give app-level state the Electron `userData` dir for its defaults.
  configureAppState(app.getPath('userData'))

  registerIpc()
  createWindow()
  logger.info('main window created')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})