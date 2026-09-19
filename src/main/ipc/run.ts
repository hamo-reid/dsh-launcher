/** IPC for the embedded profile runtime (`run:*`) + external-link opening.
 * Owns the multi-run registry: several profiles may run at once, but each
 * profile is limited to a single live process (`core/run-registry.ts` enforces
 * the decisions). The window lifecycle and tray consult this registry before
 * closing/updating status. */

import { app, BrowserWindow, dialog, shell } from 'electron'
import { handle } from './handle.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { existsExecutable, resolveLaunchEntry, type LaunchEntry } from '../core/dsh.ts'
import { buildDshLaunch } from '../core/launch-spec.ts'
import { nodeEnvironment } from '../core/node-env.ts'
import { nodePreferenceValue } from '../core/settings.ts'
import { dshEntryById, readLaunchOptions, readRunMode, writeLaunchOptions, writeRunMode } from '../core/appState.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { child, logger } from '../core/logger.ts'
import { effectiveArgs, sanitizeLaunchOptions } from '../core/launch-options.ts'
import { hasRun, nextRunId } from '../core/run-registry.ts'
import type { IpcResult, LaunchOptions, RunDefaults, RunEvent, RunInfo, RunMode } from '../../shared/types.ts'

/** One live profile runtime. */
interface RuntimeState {
  id: string
  /** The dsh install this run belongs to. */
  dshId: string
  dshName: string
  profile: string
  mode: RunMode
  child: ChildProcess
  /** When the run started (epoch ms) — for the tray "running since" display. */
  startedAt: number
  /** Joined launch argv (diagnostics). */
  command: string
  /** Rolling buffer of this run's output, so a renderer reload can repaint the
   * console without losing what the process already printed. */
  log: string
  /** Set when the user aborts, so the ensuing close is not reported as a failure. */
  stopping: boolean
}

/** Every live run, keyed by its stable id. */
const runs = new Map<string, RuntimeState>()

/** Monotonic run sequence; feeds `nextRunId` so ids never collide. */
let seq = 0

const RUN_LOG_CAP = 512 * 1024

/** Domain-tagged logger for the running dsh's live output (`{domain:"dsh-run"}`). */
const dshRunLog = child('dsh-run')

/** Mirror the dsh child's live stdout/stderr into the main log (Debug). On with
 * `DSH_RUN_TRACE=1`, or when any level env pins a sink to `debug` — so a crash or
 * a confusing console transcript stays recoverable from the archive. Off by
 * default to keep a normal run's footprint small. */
function dshRunTrace(): boolean {
  if (process.env.DSH_RUN_TRACE === '1') return true
  return [process.env.DSH_LOG_CONSOLE_LEVEL, process.env.DSH_LOG_LEVEL, process.env.DSH_LOG_FILE_LEVEL]
    .some(level => level === 'debug')
}

function toInfo(run: RuntimeState): RunInfo {
  return {
    id: run.id,
    dshId: run.dshId,
    dshName: run.dshName,
    profile: run.profile,
    mode: run.mode,
    startedAt: run.startedAt,
    command: run.command,
    status: 'running',
  }
}

/** Snapshot of every live run (serializable; no child handles, no logs). */
export function listRuns(): RunInfo[] {
  return [...runs.values()].map(toInfo)
}

// ── run-state subscription (tray status monitoring) ──────────────────────────

/** Listened to on every run start / stop (the tray updates its tooltip live). */
export type RunStateListener = (runs: RunInfo[]) => void
const runListeners = new Set<RunStateListener>()

function notifyRunState(): void {
  const snapshot = listRuns()
  for (const listener of runListeners) listener(snapshot)
}

/** Subscribe to run-set changes (start → new run, stop → removed). The callback
 * fires immediately with the current list, then on every change. Returns an
 * unsubscribe. */
export function subscribeRunState(listener: RunStateListener): () => void {
  runListeners.add(listener)
  listener(listRuns())
  return () => { runListeners.delete(listener) }
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

/** Kill the child (and, on Windows, its whole tree). */
function killChild(childProcess: ChildProcess): void {
  if (process.platform === 'win32' && childProcess.pid !== undefined) {
    spawn('taskkill', ['/pid', String(childProcess.pid), '/T', '/F'])
  } else {
    childProcess.kill()
  }
}

/** Stop one run by id. Returns false when the id is unknown (already exited). */
export function stopRun(id: string): boolean {
  const run = runs.get(id)
  if (run === undefined) return false
  logger.info(`run stopped: ${run.profile}`)
  run.stopping = true
  killChild(run.child)
  return true
}

/** Stop every live run (window close / tray quit). */
export function stopAllRuns(): void {
  for (const run of runs.values()) {
    logger.info(`run stopped: ${run.profile}`)
    run.stopping = true
    killChild(run.child)
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
  // Prepend a UTF-8 BOM: Windows PowerShell 5.1 reads a BOM-less UTF-8 script as
  // the system ANSI codepage (GBK on zh-CN), which would garble the embedded
  // paths/args when the app or user dir sits under a non-ASCII path.
  const bom = Buffer.from([0xEF, 0xBB, 0xBF])
  writeFileSync(scriptPath, Buffer.concat([bom, Buffer.from(script, 'utf8')]))
  return spawn('cmd.exe', ['/c', 'start', '', '/wait', 'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { windowsHide: false, env, cwd })
}

export function registerRunIpc(): void {
  handle('run:start', (_event, profile: string, mode?: RunMode, options?: LaunchOptions, dshId?: string): IpcResult<{ id: string }> => {
    // The target dsh is always explicit now (the Run page picks it at launch);
    // there is no global active dsh to fall back to.
    const entry = dshEntryById(dshId)
    if (entry === undefined) return fail(E.dshNotFound)
    if (hasRun([...runs.values()], entry.id, profile)) return fail(E.runAlreadyRunning, { profile })
    if (!existsExecutable(entry.execPath)) return fail(E.runExecMissing, { path: entry.execPath })
    try {
      // Resolve mode + launch parameters: explicit ones are validated and saved
      // as this profile's defaults; omitted ones reuse what was saved.
      const resolvedMode: RunMode = mode ?? readRunMode(entry.id, profile)
      const fromSaved = options === undefined
      const sanitized = sanitizeLaunchOptions(fromSaved ? readLaunchOptions(entry.id, profile) : options)
      writeRunMode(entry.id, profile, resolvedMode)
      if (!fromSaved) {
        writeLaunchOptions(entry.id, profile, {
          args: sanitized.args,
          patches: sanitized.patches,
          env: sanitized.env,
          ...(sanitized.port !== undefined && { port: sanitized.port }),
        })
      }
      // Launch the dsh entry directly with array args (no cmd/powershell command
      // string — the output pipe stays UTF-8). Prefer a system `node` when one
      // exists; fall back to the app's bundled Node only if none is on PATH.
      let launch: LaunchEntry
      try {
        launch = resolveLaunchEntry(entry.execPath)
      } catch (error) {
        return fail(E.runExecLaunchResolve, { path: entry.execPath }, error instanceof Error ? error.message : String(error))
      }
      const { cwd } = launch
      // argv/env are assembled in one place (core/launch-spec.ts) so app and shell
      // modes cannot drift apart: the bundled Electron path sets ELECTRON_RUN_AS_NODE
      // for the Electron process itself and preloads a shim that clears it before dsh
      // can spawn children; the system-node path carries neither.
      const node = resolveNodeExe()
      const { exe, argv, env } = buildDshLaunch({
        launch,
        home: entry.home,
        node,
        profile,
        args: effectiveArgs(sanitized),
        patches: sanitized.patches,
        env: sanitized.env,
      })
      const shellMode = resolvedMode === 'shell'
      const command = argv.join(' ')
      const id = nextRunId(profile, ++seq)

      let exited = false
      // A spawn failure fires 'error' (never 'close'); both must end the run once.
      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (exited) return
        exited = true
        const run = runs.get(id)
        // A user-initiated abort is a normal stop, not a failure.
        if (run?.stopping === true) { code = 0; signal = null }
        logger.info(`run exited: ${profile} (code ${String(code)}${signal ? `, sig ${signal}` : ''})`)
        runs.delete(id)
        broadcastRun({ type: 'exited', run: {
          id,
          dshId: entry.id,
          dshName: entry.name,
          profile,
          mode: run?.mode ?? resolvedMode,
          startedAt: run?.startedAt ?? Date.now(),
          command,
          status: 'exited',
          code,
          signal,
        } })
        notifyRunState()
      }

      // The process stays owned by the app in BOTH modes (so it can be stopped
      // and its state tracked). Only the I/O destination differs:
      //   app   → capture stdout/stderr into the embedded console
      //   shell → attach to a visible OS terminal window (new console)
      const runChild = shellMode
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

      const state: RuntimeState = {
        id, dshId: entry.id, dshName: entry.name, profile, mode: resolvedMode,
        child: runChild, startedAt: Date.now(), command, log: '', stopping: false,
      }
      runs.set(id, state)
      logger.info(`run started: ${profile} (${resolvedMode}, ${entry.name})`)
      notifyRunState()
      broadcastRun({ type: 'started', run: toInfo(state) })

      if (shellMode) {
        runChild.on('error', () => finish(1, null))
      } else {
        // Make explicit which home this dsh launches under, then stream output.
        const homeBanner = `\n[\x1b[36mhome\x1b[0m] DSH_HOME = ${entry.home}\n`
        state.log = homeBanner
        broadcastRun({ type: 'output', id, line: homeBanner })
        const mirrorRun = dshRunTrace()
        const onOutput = (data: Buffer): void => {
          const line = data.toString('utf8')
          if (mirrorRun) {
            const trimmed = line.trimEnd()
            if (trimmed !== '') dshRunLog.debug(trimmed)
          }
          state.log += line
          if (state.log.length > RUN_LOG_CAP) state.log = state.log.slice(-RUN_LOG_CAP)
          broadcastRun({ type: 'output', id, line })
        }
        runChild.stdout?.on('data', onOutput)
        runChild.stderr?.on('data', onOutput)
        runChild.on('error', (error) => {
          broadcastRun({ type: 'output', id, line: `[启动失败] ${error.message}\n` })
          finish(1, null)
        })
      }
      runChild.on('close', (code, signal) => finish(code, signal))
      return { ok: true, value: { id } }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('run:stop', (_event, id: string): IpcResult<boolean> => {
    if (!stopRun(id)) return fail(E.runNotFound, { id })
    return { ok: true, value: true }
  })

  handle('run:list', (): IpcResult<RunInfo[]> => {
    return { ok: true, value: listRuns() }
  })

  handle('run:logs', (_event, id: string): IpcResult<string> => {
    const run = runs.get(id)
    if (run === undefined) return fail(E.runNotFound, { id })
    return { ok: true, value: run.log }
  })

  handle('run:input', (_event, id: string, line: string): IpcResult<boolean> => {
    const run = runs.get(id)
    if (run === undefined) return fail(E.runNotFound, { id })
    try {
      run.child.stdin?.write(`${line}\n`)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Saved default mode + launch parameters for a profile of a given dsh.
  handle('run:getDefaults', (_event, dshId: string, profile: string): IpcResult<RunDefaults> => {
    return { ok: true, value: { mode: readRunMode(dshId, profile), options: readLaunchOptions(dshId, profile) } }
  })

  // Validate + persist a profile's default mode + launch parameters (also
  // happens on start; this lets the UI save without launching).
  handle('run:setDefaults', (_event, dshId: string, profile: string, defaults: RunDefaults): IpcResult<boolean> => {
    try {
      const sanitized = sanitizeLaunchOptions(defaults.options)
      writeLaunchOptions(dshId, profile, {
        args: sanitized.args,
        patches: sanitized.patches,
        env: sanitized.env,
        ...(sanitized.port !== undefined && { port: sanitized.port }),
      })
      writeRunMode(dshId, profile, defaults.mode === 'shell' ? 'shell' : 'app')
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Pick a cordis patch overlay file for the launch parameters. `''` = cancelled.
  handle('run:pickPatch', async (): Promise<IpcResult<string>> => {
    const win = BrowserWindow.getFocusedWindow()
    const result = win === null
      ? await dialog.showOpenDialog({ title: '选择 patch 文件', properties: ['openFile'], filters: [{ name: 'Cordis patch', extensions: ['yml', 'yaml'] }] })
      : await dialog.showOpenDialog(win, { title: '选择 patch 文件', properties: ['openFile'], filters: [{ name: 'Cordis patch', extensions: ['yml', 'yaml'] }] })
    if (result.canceled || result.filePaths.length === 0) return { ok: true, value: '' }
    return { ok: true, value: result.filePaths[0] }
  })

  // Open a surfaced URL with the system default handler (never a bare anchor).
  // Only http(s) is allowed — a console line must not be able to open arbitrary
  // local paths or protocols.
  handle('openExternal', (_event, url: string): IpcResult<boolean> => {
    try {
      if (!/^https?:\/\/\S+$/.test(url)) return fail(E.runOpenHttpOnly)
      void shell.openExternal(url)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })
}
