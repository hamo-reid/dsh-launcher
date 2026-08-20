/** Main process: window lifecycle + IPC wiring. Every handler lives in its own
 * domain module under `src/main/ipc/`; this file only assembles them. */

import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from 'electron'
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
import { closeToTrayEnabled, openDatabase } from './core/settings.ts'
import { configureAppState } from './core/appState.ts'

// Process-level breadcrumbs for anything that escapes the IPC try/catch.
process.on('uncaughtException', (error) => logger.error('uncaughtException', error))
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', reason))

/** Owned at module scope so the OS tray icon isn't garbage-collected away. */
let tray: Tray | null = null
/** Set once a real quit is requested (via tray 退出 / app.quit), so the window
 * close handler doesn't re-intercept it into another hide-to-tray. */
let quitting = false
app.on('before-quit', () => { quitting = true })

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

  // ── 系统托盘（Windows 左下角）托管 ────────────────────────────────────────
  // 图标复用 build/icon.ico;右键菜单含运行状态 + 显示/隐藏 + 退出。
  const showWindow = (): void => {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  const buildTrayMenu = (): void => {
    const running = currentRun()
    tray?.setContextMenu(Menu.buildFromTemplate([
      { label: running === null ? '状态：空闲' : `运行中：${running.profile}`, enabled: false },
      { type: 'separator' },
      { label: '显示主窗口', click: () => showWindow() },
      { label: '隐藏到托盘', click: () => win.hide() },
      { type: 'separator' },
      {
        label: '退出 DSH Launcher',
        click: () => {
          quitting = true
          if (running !== null) terminateAndClear(running.child)
          app.quit()
        },
      },
    ]))
  }
  tray = new Tray(nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.ico')))
  tray.setToolTip('DSH Launcher')
  buildTrayMenu()
  tray.on('click', () => { if (win.isVisible()) win.hide(); else showWindow() })
  tray.on('right-click', buildTrayMenu)

  // Every browsing link goes to the system default browser — never open a bare
  // Electron window (window.open / target=_blank) or navigate the app away to an
  // external http(s) page. Mirrors how the run-console opens links.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (/^https?:/i.test(url)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  // Guard exit while a profile process is still running: ask first, and only
  // terminate if the user chooses to.
  let allowClose = false
  win.on('close', (event) => {
    if (allowClose || quitting) return
    // 默认关闭行为：最小化到托盘（窗口隐藏，app 继续后台运行）。
    // 在设置里可改为「直接退出」，此时才走下面的运行中进程保护。
    if (closeToTrayEnabled()) {
      event.preventDefault()
      win.hide()
      return
    }
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