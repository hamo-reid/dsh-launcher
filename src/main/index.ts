/** Main process: window lifecycle + IPC wiring. Every handler lives in its own
 * domain module under `src/main/ipc/`; this file only assembles them. */

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { join } from 'node:path'
import os from 'node:os'
import { currentRun, formatRunDuration, registerRunIpc, subscribeRunState, terminateAndClear, type RuntimeState } from './ipc/run.ts'
import { registerProfileIpc } from './ipc/profile.ts'
import { registerHomeIpc } from './ipc/home.ts'
import { registerPluginsIpc } from './ipc/plugins.ts'
import { registerDshIpc } from './ipc/dsh.ts'
import { registerHomeDataIpc } from './ipc/home-data.ts'
import { registerTrashIpc } from './ipc/trash.ts'
import { registerMarketIpc } from './ipc/market.ts'
import { registerSettingsIpc } from './ipc/settings.ts'
import { registerStoreIpc } from './ipc/store.ts'
import { hookWindowMaximize, registerWindowIpc } from './ipc/window.ts'
import { registerLogsIpc } from './ipc/logs.ts'
import { child, initLogger, logger, printBanner } from './core/logger.ts'
import { askOnCloseEnabled, closeToTrayEnabled, loadSettings, openDatabase, saveSettings } from './core/settings.ts'
import { configureAppState, pluginDir } from './core/appState.ts'
import { repairArchiveLinks } from './core/plugins.ts'

/** Domain-tagged logger for renderer-sourced messages (`{domain:"renderer"}`). */
const rlog = child('renderer')

// Process-level breadcrumbs for anything that escapes the IPC try/catch.
process.on('uncaughtException', (error) => logger.error('uncaughtException', error))
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', reason))

/** Owned at module scope so the OS tray icon isn't garbage-collected away. */
let tray: Tray | null = null
/** Set once a real quit is requested (via tray 退出 / app.quit), so the window
 * close handler doesn't re-intercept it into another hide-to-tray. */
let quitting = false
app.on('before-quit', () => { quitting = true })

// ── 启动画面（splash）────────────────────────────────────────────────────────
// Portable / 冷启动里 Electron 就绪前的解范围内（DB 打开、i18n、渲染 bundle
// 解析）可能很慢。用一个无 JS 的极轻 data:URL 加载页立刻给出「正在启动」反馈，
// 主窗口渲染就绪（`ready-to-show`）后收起。解压那一段发生在进程启动前，无法
// 用应用自身 UI 覆盖（electron-builder portable 自带系统级解压进度）。
const SPLASH_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;display:flex;align-items:center;justify-content:center;font-family:-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif}
.card{width:340px;padding:28px;border-radius:16px;background:linear-gradient(160deg,#1c2740,#0f1526);color:#fff;display:flex;flex-direction:column;gap:16px;align-items:center;box-shadow:0 12px 40px rgba(0,0,0,.35)}
.brand{font-size:20px;font-weight:700;letter-spacing:.3px}
.sub{font-size:12px;color:rgba(255,255,255,.7)}
.spinner{width:40px;height:40px;border:4px solid rgba(255,255,255,.18);border-top-color:#4f7bff;border-radius:50%;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.bar{width:100%;height:5px;border-radius:3px;overflow:hidden;background:rgba(255,255,255,.14)}
.bar>i{display:block;height:100%;width:45%;border-radius:3px;background:linear-gradient(90deg,#4f7bff,#7aa2ff);animation:slide 1.1s ease-in-out infinite}
@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
</style></head><body><div class="card">
<div class="brand">DSH Launcher</div>
<div class="spinner"></div>
<div class="bar"><i></i></div>
<div class="sub">正在启动…</div>
</div></body></html>`

let splash: BrowserWindow | null = null
let revealTimer: NodeJS.Timeout | undefined

/** Create + show the lightweight startup splash (frameless, transparent). */
function createSplash(): void {
  splash = new BrowserWindow({
    width: 380,
    height: 240,
    frame: false,
    transparent: true,
    resizable: false,
    show: false,
    center: true,
    skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  splash.once('ready-to-show', () => { if (splash !== null && !splash.isDestroyed()) splash.show() })
  void splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML))
    .catch(err => logger.warn(`splash load failed: ${String(err)}`))
}

/** Tear down the splash (idempotent: safe when never created / already closed). */
function closeSplash(): void {
  if (splash !== null && !splash.isDestroyed()) splash.close()
  splash = null
  if (revealTimer !== undefined) { clearTimeout(revealTimer); revealTimer = undefined }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    title: 'DSH Launcher',
    // Keep hidden until the renderer is ready; revealed behind the startup splash
    // so a slow Portable/cold start never flashes a blank window.
    show: false,
    // Frameless: the renderer provides its own title bar (brand + window controls).
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Explicit (Electron ≥20 defaults true anyway): the preload only uses
      // contextBridge + ipcRenderer, so sandboxing is safe and keeps any future
      // fs/node usage in the renderer from silently enabling an unsandboxed web.
      sandbox: true,
    },
  })
  hookWindowMaximize(win)

  // Close the splash and show the window once the renderer is ready. A 15s
  // fallback still dismisses the splash even if ready-to-show never fires
  // (degrades to the previous show-immediately behaviour rather than hanging).
  revealTimer = setTimeout(() => {
    closeSplash()
    if (!win.isDestroyed()) win.show()
  }, 15000)
  win.once('ready-to-show', () => {
    if (revealTimer !== undefined) { clearTimeout(revealTimer); revealTimer = undefined }
    closeSplash()
    if (!win.isDestroyed()) { win.show(); win.focus() }
  })
  win.on('closed', () => {
    if (revealTimer !== undefined) { clearTimeout(revealTimer); revealTimer = undefined }
    closeSplash()
  })

  // ── 系统托盘（Windows 左下角）托管 ────────────────────────────────────────
  // 图标复用 build/icon.ico;右键菜单含运行状态 + 显示/隐藏 + 退出。
  const showWindow = (): void => {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  // Build the tray context menu. On Windows we can NOT rely on `setContextMenu`,
  // which would let the OS auto-show a STALE cached copy and swallow the
  // `right-click` event. Instead the menu is built fresh and popped up on every
  // right-click, so the status line always reflects `currentRun()` at that moment.
  const showTrayMenu = (): void => {
    const running = currentRun()
    // 状态监控：右击瞬间取最新状态；运行中追加已运行时长。
    const status = running === null
      ? '状态：空闲'
      : `运行中：${running.profile} · ${formatRunDuration(Date.now() - running.startedAt)}`
    Menu.buildFromTemplate([
      { label: status, enabled: false },
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
    ]).popup()
  }
  tray = new Tray(nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.ico')))
  tray.setToolTip('DSH Launcher')
  // No persistent context menu on Windows — see `showTrayMenu` above.
  tray.setContextMenu(null)
  tray.on('click', () => { if (win.isVisible()) win.hide(); else showWindow() })
  tray.on('right-click', showTrayMenu)

  // 实时状态监控（tooltip 通道）：run 启动/停止时立即更新托盘悬浮提示，无需等右击。
  const updateTrayState = (state: RuntimeState | null): void => {
    if (tray === null) return
    tray.setToolTip(state === null ? 'DSH Launcher' : `运行中：${state.profile}`)
  }
  subscribeRunState(updateTrayState)

  // Renderer-side errors/warnings are echoed into the main log under the
  // `renderer` domain, so a bug that only surfaces in the web layer still lands
  // in the same daily archive (grep `{domain:"renderer"}`). The message itself
  // is untrusted renderer text, so it is recorded as data, never as code.
  // Modern Electron signature: params ride directly on the Event object, with
  // `level` as a severity string ('verbose'|'info'|'warning'|'error').
  win.webContents.on('console-message', (event) => {
    const { level, message, lineNumber, sourceId } = event
    const meta = { sourceId, line: lineNumber }
    if (level === 'error') rlog.error(`renderer: ${message}`, meta)
    else if (level === 'warning') rlog.warn(`renderer: ${message}`, meta)
    else rlog.debug(`renderer: ${message}`, meta)
  })

  // Every browsing link goes to the system default browser — never open a bare
  // Electron window (window.open / target=_blank) or navigate the app away to an
  // external http(s) page. Mirrors how the run-console opens links.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The app must never navigate away from its own renderer. Keep the preload-
  // exposed IPC surface away from attacker-controllable pages (an arbitrary
  // file:// page navigating from a XSS'd renderer would inherit `window.api`).
  // Allow only the app's own initial URL; route external http(s) to the browser.
  const isOwnPage = (url: string): boolean => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (dev !== undefined) return url.startsWith(new URL(dev).origin)
    return url.startsWith('file://') && url.includes('/renderer/index.html')
  }
  win.webContents.on('will-navigate', (event, url) => {
    if (isOwnPage(url)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })

  // Ask whether to minimize-to-tray or quit when closing, unless the user
  // picked "don't ask again". In prompt mode the renderer shows an in-app modal
  // (so it can carry the "remember" checkbox); the chosen action is executed via
  // `window:chooseClose`. In no-prompt mode the configured `closeToTray`
  // behaviour applies directly, with the profile-run guard below.
  const confirmTerminate = (active: RuntimeState): void => {
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
  }
  let allowClose = false

  // Renderer → main: the user picked minimize-to-tray or quit in the prompt
  // modal. If they ticked "don't ask again", persist the choice (behaviour +
  // ask=false) so future closes follow it without prompting.
  ipcMain.removeHandler('window:chooseClose')
  ipcMain.handle('window:chooseClose', (_event, action: 'tray' | 'quit', remember: boolean) => {
    if (remember) {
      saveSettings({ ...loadSettings(), closeToTray: action === 'tray', askOnClose: false })
    }
    if (action === 'tray') {
      if (!win.isDestroyed()) win.hide()
      return
    }
    const active = currentRun()
    if (active !== null) terminateAndClear(active.child)
    allowClose = true
    app.quit()
  })

  win.on('close', (event) => {
    if (allowClose || quitting) return
    // Prompt mode → tell the renderer to show the minimize/quit modal.
    if (askOnCloseEnabled()) {
      event.preventDefault()
      win.webContents.send('window:askClose', { running: currentRun()?.profile })
      return
    }
    // "Don't ask" mode: follow the configured close behaviour directly.
    if (closeToTrayEnabled()) {
      event.preventDefault()
      win.hide()
      return
    }
    const active = currentRun()
    if (active === null) return
    event.preventDefault()
    confirmTerminate(active)
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
  registerMarketIpc()
  registerStoreIpc()
  registerDshIpc()
  registerHomeDataIpc()
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
  // Signature launch logo — the first thing on the console, colour-graded so a
  // startup is instantly recognisable against the log stream that follows.
  printBanner([
    ' ',
    ' ██████╗ ███████╗██╗  ██╗',
    ' ██╔══██╗██╔════╝██║  ██║',
    ' ██║  ██║███████╗███████║',
    ' ██║  ██║╚════██║██╔══██║',
    ' ██████╔╝███████║██║  ██║',
    ' ╚═════╝ ╚══════╝╚═╝  ╚═╝',
    `         LAUNCHER · v${app.getVersion()}`,
  ], '96')

  // Show the startup splash as early as possible — before the DB open / renderer
  // load that a cold start must wait on.
  createSplash()

  // Open the SQLite settings database before any IPC touches it.
  await openDatabase(join(app.getPath('userData'), 'app.sqlite'))
  // Give app-level state the Electron `userData` dir for its defaults.
  configureAppState(app.getPath('userData'))

  // Rewire any pre-existing broken archive top-level links (installed before the
  // install-time re-link existed) so previously-downloaded plugins surface again.
  // Fire-and-forget: a clean store is a read-only no-op; the IPC path reads live
  // disk, so whatever succeeds here is already visible by the time the UI asks.
  repairArchiveLinks(pluginDir()).catch(error => logger.warn(`store relink failed: ${String(error)}`))

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