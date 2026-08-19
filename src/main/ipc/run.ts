/** IPC for the embedded profile runtime (`run:*`) + external-link opening.
 * Owns the single running child-process state that the window lifecycle also
 * consults before closing. */

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseLaunch, existsExecutable, resolveInstallAnchor } from '../core/dsh.ts'
import { activeDshEntry } from '../core/appState.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { logger } from '../core/logger.ts'
import type { IpcResult, RunEvent } from '../../shared/types.ts'

/** The currently running embedded profile runtime (single instance). */
export interface RuntimeState {
  profile: string
  child: ChildProcess
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

/** Kill the child (and, on Windows, its whole tree) and drop the runtime state
 * if it belongs to the current run. */
export function terminateAndClear(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
  } else {
    child.kill()
  }
  if (running !== null && running.child === child) running = null
}

function broadcastRun(event: RunEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('run:event', event)
}

/** Open a visible PowerShell window running `command`, kept as a direct child
 * (via `cmd /c start /wait`) so the app can still abort it with taskkill /T.
 * The command lives in a temp .ps1 to avoid cmd's quote-munging on the nested
 * dsh invocation. */
function launchShellWindow(command: string, env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
  const scriptPath = join(app.getPath('userData'), 'dsh-launch.ps1')
  const script = `$ErrorActionPreference = 'Continue'\n& ${command}\n`
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
      const command = `${baseLaunch(entry.execPath)} --profile ${profile}`
      const env = { ...process.env, DSH_HOME: entry.home }
      // Node's `--import tsx` resolves `tsx` from the child's cwd; anchor the
      // child at the dsh install root so a source checkout finds its tooling.
      const cwd = resolveInstallAnchor(entry.execPath) ?? entry.home
      const shellMode = mode === 'shell'
      runCommand = command
      let exited = false
      // A spawn failure fires 'error' (never 'close'); both must end the run once.
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (exited) return
        exited = true
        // A user-initiated abort is a normal stop, not a failure.
        if (intentionalStop) { code = 0; signal = null }
        intentionalStop = false
        logger.info(`run exited: ${running?.profile ?? '?'} (code ${String(code)}${signal ? `, sig ${signal}` : ''})`)
        broadcastRun({ type: 'exited', code, signal, command })
        running = null
      }
      // The process stays owned by the app in BOTH modes (so it can be stopped
      // and its state tracked). Only the I/O destination differs:
      //   app   → capture stdout/stderr into the embedded console
      //   shell → attach to a visible OS terminal window (new console)
      const child = shellMode
        ? (process.platform === 'win32'
            ? launchShellWindow(command, env, cwd)
            : spawn(command, { shell: true, detached: true, stdio: 'inherit', env, cwd }))
        : spawn(command, {
            shell: process.platform === 'win32',
            // Keep stdin open as a pipe: a /dev/null stdin makes an interactive
            // CLI read EOF and exit immediately on launch.
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
            cwd,
          })
      logger.info(`run started: ${profile} (${mode}, ${entry.name})`)
      running = { profile, child }
      if (shellMode) {
        child.on('error', () => finish(1, null))
      } else {
        // Make explicit which home this dsh launches under, then stream output.
        const homeBanner = `\n[\x1b[36mhome\x1b[0m] DSH_HOME = ${entry.home}\n`
        runLog = homeBanner
        broadcastRun({ type: 'output', line: homeBanner })
        const onOutput = (data: Buffer): void => {
          runLog += String(data)
          if (runLog.length > RUN_LOG_CAP) runLog = runLog.slice(-RUN_LOG_CAP)
          broadcastRun({ type: 'output', line: String(data) })
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