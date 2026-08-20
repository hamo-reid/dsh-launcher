/** IPC for the embedded profile runtime (`run:*`) + external-link opening.
 * Owns the single running child-process state that the window lifecycle also
 * consults before closing. */

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { existsExecutable, resolveLaunchEntry, type LaunchEntry } from '../core/dsh.ts'
import { nodeEnvironment } from '../core/node-env.ts'
import { nodePreferenceValue } from '../core/settings.ts'
import { activeDshEntry } from '../core/appState.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { logger } from '../core/logger.ts'
import type { IpcResult, RunEvent } from '../../shared/types.ts'

/** The currently running embedded profile runtime (single instance). */
export interface RuntimeState {
  profile: string
  child: ChildProcess
  /** When the run started (epoch ms) — for the tray "running since" display. */
  startedAt: number
}

let running: RuntimeState | null = null

/** The launch command of the most recent `run:start` attempt (for diagnostics). */
let runCommand = ''

/** Set when the user aborts, so the ensuing probe close is not reported as a failure. */
let intentionalStop = false

/** Rolling buffer of the current run's output, so a renderer reload can repaint
 * the console without losing what the process already printed. */
let runLog = ''
const RUN_LOG_CAP = 512 * 1024

/** The currently running child, for the window-close guard. */
export function currentRun(): RuntimeState | null {
  return running
}

// ── run-state subscription (tray status monitoring) ──────────────────────────

/** Listened to on every run start / stop (the tray updates its tooltip live). */
export type RunStateListener = (state: RuntimeState | null) => void
const runListeners = new Set<RunStateListener>()

function notifyRunState(): void {
  const state = running
  for (const listener of runListeners) listener(state)
}

/** Subscribe to run-state changes (start → running state, stop → `null`). The
 * callback fires immediately with the current state, then on every change.
 * Returns an unsubscribe. */
export function subscribeRunState(listener: RunStateListener): () => void {
  runListeners.add(listener)
  listener(running)
  return () => { runListeners.delete(listener) }
}

/** Human-readable run duration from a `startedAt` epoch, e.g. `3 分 12 秒`. */
export function formatRunDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h} 时 ${m} 分 ${s} 秒`
  if (m > 0) return `${m} 分 ${s} 秒`
  return `${s} 秒`
}

/**
 * Which node runs the embedded dsh. Prefers a usable SYSTEM `node` when one is
 * on PATH (the user asked to use it in node-equipped environments); falls back
 * to the app's bundled Node 24 (always satisfies dsh, keeps it self-contained).
 * Detection + the decision live in `core/node-env.ts` (shared with the settings
 * page display), cached once.
 */
function resolveNodeExe(): { exe: string; bundled: boolean } {
  const env = nodeEnvironment(nodePreferenceValue())
  return env.prefer === 'system' ? { exe: 'node', bundled: false } : { exe: process.execPath, bundled: true }
}

/** Kill the child (and, on Windows, its whole tree) and drop the runtime state
 * if it belongs to the current run. */
export function terminateAndClear(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
  } else {
    child.kill()
  }
  if (running !== null && running.child === child) {
    running = null
    notifyRunState()
  }
}

function broadcastRun(event: RunEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('run:event', event)
}

/** Open a visible PowerShell window running the bundled Node with `argv` as the
 * dsh launch (kept as a `cmd /c start /wait` child so the app can still abort it
 * with taskkill /T). Force UTF-8 on the child console + pipeline so dsh's UTF-8
 * output never gets re-encoded to the system codepage (GBK) → mojibake. */
function launchShellWindow(exe: string, argv: string[], env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
  const scriptPath = join(app.getPath('userData'), 'dsh-launch.ps1')
  const psQuote = (raw: string): string => `'${raw.replace(/'/g, "''")}'`
  const script = [
    "chcp 65001 > $null",
    '$ErrorActionPreference = \'Continue\'',
    '[Console]::OutputEncoding=[Console]::InputEncoding=[Text.UTF8Encoding]::new()',
    `& ${psQuote(exe)} ${argv.map(psQuote).join(' ')}`,
  ].join('\n')
  writeFileSync(scriptPath, script)
  return spawn('cmd.exe', ['/c', 'start', '', '/wait', 'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: false, env, cwd })
}

export function registerRunIpc(): void {
  ipcMain.handle('run:start', (_event, profile: string, mode: 'app' | 'shell' = 'app'): IpcResult<boolean> => {
    if (running !== null) return fail('run.alreadyRunning', { profile: running.profile })
    const entry = activeDshEntry()
    if (entry === undefined) return fail(E.needActiveDsh)
    if (!existsExecutable(entry.execPath)) return fail('run.execMissing', { path: entry.execPath })
    try {
      // Launch the dsh entry directly with array args (no cmd/powershell command
      // string — the output pipe stays UTF-8). Prefer a system `node` when one
      // exists; fall back to the app's bundled Node only if none is on PATH.
      let launch: LaunchEntry
      try {
        launch = resolveLaunchEntry(entry.execPath)
      } catch (error) {
        return fail('run.execLaunchResolve', { path: entry.execPath }, error instanceof Error ? error.message : String(error))
      }
      const { script, tsx, cwd } = launch
      // dsh's HMR service (cordis-plugin-hmr) requires the Node `--expose-internals`
      // flag; harmless for every other profile. Applies to both bundled & system node.
      const argv = tsx
        ? ['--expose-internals', '--import', 'tsx/esm', script, '--profile', profile]
        : ['--expose-internals', script, '--profile', profile]
      const { exe } = resolveNodeExe()
      // ELECTRON_RUN_AS_NODE is only meaningful for electron.exe; a system `node`
      // ignores it, so it can be set unconditionally.
      const env = { ...process.env, DSH_HOME: entry.home, ELECTRON_RUN_AS_NODE: '1' }
      const shellMode = mode === 'shell'
      runCommand = argv.join(' ')
      let exited = false
      // A spawn failure fires 'error' (never 'close'); both must end the run once.
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (exited) return
        exited = true
        // A user-initiated abort is a normal stop, not a failure.
        if (intentionalStop) { code = 0; signal = null }
        intentionalStop = false
        logger.info(`run exited: ${running?.profile ?? '?'} (code ${String(code)}${signal ? `, sig ${signal}` : ''})`)
        broadcastRun({ type: 'exited', code, signal, command: runCommand })
        running = null
        notifyRunState()
      }
      // The process stays owned by the app in BOTH modes (so it can be stopped
      // and its state tracked). Only the I/O destination differs:
      //   app   → capture stdout/stderr into the embedded console
      //   shell → attach to a visible OS terminal window (new console)
      const child = shellMode
        ? (process.platform === 'win32'
            ? launchShellWindow(exe, argv, env, cwd)
            : spawn(exe, argv, { shell: false, detached: true, stdio: 'inherit', env, cwd }))
        : spawn(exe, argv, {
            shell: false,
            // Keep stdin open as a pipe: a /dev/null stdin makes an interactive
            // CLI read EOF and exit immediately on launch.
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
            cwd,
            windowsHide: true,
          })
      logger.info(`run started: ${profile} (${mode}, ${entry.name})`)
      running = { profile, child, startedAt: Date.now() }
      notifyRunState()
      if (shellMode) {
        child.on('error', () => finish(1, null))
      } else {
        // Make explicit which home this dsh launches under, then stream output.
        const homeBanner = `\n[\x1b[36mhome\x1b[0m] DSH_HOME = ${entry.home}\n`
        runLog = homeBanner
        broadcastRun({ type: 'output', line: homeBanner })
        const onOutput = (data: Buffer): void => {
          const line = data.toString('utf8')
          runLog += line
          if (runLog.length > RUN_LOG_CAP) runLog = runLog.slice(-RUN_LOG_CAP)
          broadcastRun({ type: 'output', line })
        }
        child.stdout?.on('data', onOutput)
        child.stderr?.on('data', onOutput)
        child.on('error', (error) => {
          broadcastRun({ type: 'output', line: `[启动失败] ${error.message}\n` })
          finish(1, null)
        })
      }
      child.on('close', (code, signal) => finish(code, signal))
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('run:stop', (): IpcResult<boolean> => {
    if (running === null) return fail('run.notRunning')
    logger.info(`run stopped: ${running.profile}`)
    intentionalStop = true
    terminateAndClear(running.child)
    return { ok: true, value: true }
  })

  ipcMain.handle('run:state', (): IpcResult<{ running: boolean; profile?: string }> => {
    return { ok: true, value: running ? { running: true, profile: running.profile } : { running: false } }
  })

  ipcMain.handle('run:command', (): IpcResult<string> => {
    return { ok: true, value: runCommand }
  })

  ipcMain.handle('run:logs', (): IpcResult<string> => {
    return { ok: true, value: runLog }
  })

  ipcMain.handle('run:input', (_event, line: string): IpcResult<boolean> => {
    if (running === null) return fail('run.notRunning')
    try {
      running.child.stdin?.write(`${line}\n`)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Open a surfaced URL with the system default handler (never a bare anchor).
  // Only http(s) is allowed — a console line must not be able to open arbitrary
  // local paths or protocols.
  ipcMain.handle('openExternal', (_event, url: string): IpcResult<boolean> => {
    try {
      if (!/^https?:\/\/\S+$/.test(url)) return fail('run.openHttpOnly')
      void shell.openExternal(url)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })
}