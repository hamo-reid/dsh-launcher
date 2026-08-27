/** Run pnpm in a directory, capturing output. Async (non-blocking the UI thread).
 *
 * Runs pnpm on Electron's OWN bundled Node — `process.execPath` under
 * `ELECTRON_RUN_AS_NODE` is a plain Node runtime — instead of relying on a
 * system `node` and a global pnpm from PATH. That way a user without Node/pnpm
 * (or with a mismatched pnpm version) still works, and the pnpm version is
 * locked to the app's dependency. */

import { spawn } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import { dirname, join, parse } from 'node:path'
import { child, logger } from './logger.ts'
import { nodeEnvironment } from './node-env.ts'
import { nodePreferenceValue } from './settings.ts'

/** Domain-tagged logger for anything pnpm-related — grep `{domain:"pnpm"}`. */
const plog = child('pnpm')

const require = createRequire(import.meta.url)

export interface PnpmResult {
  ok: boolean
  /** Trimmed combined stdout+stderr. */
  text: string
  /** True when the run was cut short via the caller's AbortSignal. */
  aborted?: boolean
}

/** pnpm's JS entry, resolved from node_modules (inside the packaged asar at
 * runtime). Cached. Throws if pnpm is not installed. */
let pnpmEntry: string | null = null
function resolvePnpmEntry(): string {
  if (pnpmEntry === null) {
    // Packaged, pnpm (with its native `fastlist` executable) is relocated to
    // `app.asar.unpacked` — Electron can't `require` it from inside `app.asar`, so
    // resolve it there by `process.resourcesPath`. In dev there is no unpacked
    // pnpm, so fall back to a normal `require.resolve`.
    // `process.resourcesPath` only exists under Electron; guard it so the node-side
    // tests (and dev) fall straight back to `require.resolve` without `join` NaN.
    const unpacked = process.resourcesPath !== undefined
      ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
      : ''
    pnpmEntry = (unpacked !== '' && existsSync(unpacked))
      ? unpacked
      : join(dirname(require.resolve('pnpm')), 'bin', 'pnpm.cjs')
  }
  return pnpmEntry
}

/** Content-level success check: pnpm may exit non-zero yet still have installed
 * (e.g. it emits `ERR_PNPM_IGNORED_BUILDS` and exits 1, but every package is
 * present in the output). Key on the install-output markers, not the exit code. */
export function installSucceeded(text: string): boolean {
  // At least one package must actually have been added. `added 0` (e.g. pnpm's
  // progress lines after a resolution failure) is NOT success — matching it would
  // hide the real error and let a failed install fall through to a false ok.
  return /added [1-9][0-9]*|Done in/.test(text)
}

/** Collapse ANSI colours, progress carriage-returns and blank lines, then keep
 * the tail — enough to read the install result (`added N packages`, `Done in`)
 * or the failure reason. */
function summarizePnpmOut(out: string): string {
  return out
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-20)
    .join('\n')
}

/** Node to drive pnpm with: the setting-preferred one when usable, else the
 * bundled Node (keeps pnpm available offline even without a system node). */
function resolvePnpmNode(): string {
  return nodeEnvironment(nodePreferenceValue()).prefer === 'system' ? 'node' : process.execPath
}

/** The shared, content-addressed pnpm store for the plugin library. Lives INSIDE
 * the plugin dir (`<pluginDir>/.pnpm-store`) so it is always on the same volume as
 * the archived node_modules — that is what lets multiple stack versions hard-link
 * the same dependency to one on-disk copy instead of copying it per version. Keep
 * it with the plugin dir so moving the library moves the cache with it. */
export function pnpmStoreDir(storeDir: string): string {
  return join(storeDir, '.pnpm-store')
}

/** The pnpm's default per-user store, if any (mirrored on first use to seed the
 * library-scoped store without a re-download when both are on the same volume). */
function defaultPnpmStoreRoot(): string {
  // `APPDATA` is honoured on every platform (not just win32) so tests and Cit can
  // point a fake default store at it. win32 defaults to APPDATA too.
  const appData = process.env.APPDATA
    ?? (process.platform === 'win32' ? join(os.homedir(), 'AppData', 'Roaming') : '')
  const candidates = [
    appData !== '' ? join(appData, 'pnpm', 'store') : '',
    join(os.homedir(), '.local', 'share', 'pnpm', 'store'),
    join(os.homedir(), '.pnpm-store'),
  ].filter(Boolean)
  return candidates.find(path => existsSync(path)) ?? ''
}

/** Whether two paths resolve to the same drive/volume (hard-links can't cross it). */
const sameVolume = (a: string, b: string): boolean => parse(a).root === parse(b).root

/** Recursively hard-link every regular file under `src` into `dst` (same layout).
 * Hard-links reference the same on-disk content: no extra disk, and any archived
 * node_modules pointing at those inodes stay valid across the mirror. */
function mirrorStoreLinks(src: string, dst: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(d, { recursive: true })
      mirrorStoreLinks(s, d)
    } else if (entry.isFile()) {
      try { linkSync(s, d) } catch { /* ignore transient/locked entries */ }
    }
  }
}

/** Ensure the library-scoped store dir exists and (when the store is empty and the
 * default pnpm store is on the SAME volume) seed it by hard-linking the default
 * store's content. Same-drive → zero re-download and the default store stays
 * untouched for other projects. Cross-drive → skipped, letting pnpm create an empty
 * store and fetch from the network once. Idempotent via `existsSync`. */
export function ensurePnpmStore(storeDir: string | undefined): void {
  if (storeDir === undefined || storeDir === '') return
  const dest = pnpmStoreDir(storeDir)
  if (existsSync(dest)) return
  const src = defaultPnpmStoreRoot()
  if (src === '' || !sameVolume(dest, src)) return
  try {
    mkdirSync(dest, { recursive: true })
    mirrorStoreLinks(src, dest)
    logger.info(`plugin store: seeded .pnpm-store from default store at ${src}`)
  } catch (error) {
    logger.warn(`plugin store: could not seed store: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Run `pnpm <args>` with cwd, resolving on process exit. When `signal` is given
 * and the caller aborts it, the pnpm child (and its sub-process tree) is killed
 * and the promise resolves with `{ ok: false, aborted: true }`. When `storeDir` is
 * given, a `--store-dir <pluginDir>/.pnpm-store` is injected so installs share the
 * plugin-library store regardless of cwd (keeps hard-link dedup on the same volume). */
export function runPnpm(cwd: string, args: readonly string[], signal?: AbortSignal, opts?: { storeDir?: string }): Promise<PnpmResult> {
  return new Promise((resolve) => {
    if (opts?.storeDir !== undefined && opts.storeDir !== '') ensurePnpmStore(opts.storeDir)
    const storeDir = opts?.storeDir !== undefined && opts.storeDir !== ''
      ? pnpmStoreDir(opts.storeDir)
      : undefined
    const fullArgs = storeDir !== undefined ? ['--store-dir', storeDir, ...args] : args
    const started = Date.now()
    // Stream pnpm's live stdout/stderr when Debug monitoring is requested.
    const trace = tracePnpm()
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(resolvePnpmNode(), [resolvePnpmEntry(), ...fullArgs], {
        cwd,
        // Absolute execPath + array args: no shell, so a spacey packaged exe name
        // or a spacey pnpm-entry path is passed correctly (no quoting hazards).
        shell: false,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    } catch (error) {
      plog.error('pnpm failed to start', error)
      resolve({ ok: false, text: error instanceof Error ? error.message : String(error) })
      return
    }
    // Structured spawn breadcrumb: confirm which node/entry drives pnpm, where,
    // with what flags, and the child pid (kill-target for future Debug actions).
    plog.debug(`pnpm spawn: ${fullArgs.join(' ')} @ ${cwd}`, {
      cwd, args: fullArgs, node: resolvePnpmNode(), entry: resolvePnpmEntry(), storeDir, pid: child.pid,
    })
    const onAbort = (): void => { if (child.pid !== undefined) killProcessTree(child.pid) }
    if (signal !== undefined) {
      // Aborted before spawn: kill as soon as the child exists.
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    // `out` accumulates the combined dump (feeds installSucceeded + failure tail);
    // when tracing, stdout/stderr are ALSO streamed line-by-line as they arrive.
    let out = ''
    let partial = ''
    const stream = (chunk: Buffer, tag: string): void => {
      if (!trace) return
      partial += String(chunk)
      let idx
      while ((idx = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, idx).trimEnd()
        partial = partial.slice(idx + 1)
        if (line !== '') plog.debug(`pnpm[${tag}] ${line}`)
      }
    }
    child.stdout?.on('data', (data: Buffer) => { out += String(data); stream(data, 'out') })
    child.stderr?.on('data', (data: Buffer) => { out += String(data); stream(data, 'err') })
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      plog.warn(`pnpm failed to run: ${error.message}`)
      resolve({ ok: false, text: error.message })
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      const durMs = Date.now() - started
      const last = partial.trimEnd()
      if (last !== '') plog.debug(`pnpm[out] ${last}`) // final line lacking a newline
      // A user-cancel is distinct from a genuine failure — the caller may want to
      // clean up its staging dir and surface "cancelled", not an error.
      const aborted = signal !== undefined && signal.aborted
      if (aborted) {
        // Preserve how far the download/install got before the user cancelled.
        const tail = summarizePnpmOut(out)
        plog.warn(`pnpm aborted @ ${cwd}`, { durMs })
        if (tail !== '') plog.warn(`pnpm partial output:\n${tail}`)
        resolve({ ok: false, text: 'cancelled', aborted: true })
        return
      }
      // Real installs (even when exit != 0, e.g. ignored build scripts) count as ok.
      const ok = code === 0 || installSucceeded(out)
      const tail = summarizePnpmOut(out)
      if (ok) {
        plog.debug(`pnpm ok @ ${cwd}${tail !== '' ? `\n${tail}` : ''}`, { code, durMs })
      } else {
        plog.warn(`pnpm failed (exit ${String(code)}, ${durMs}ms) @ ${cwd}`)
        if (tail !== '') plog.warn(`pnpm output:\n${tail}`)
      }
      resolve({ ok, text: out.trim() })
    })
  })
}

/** Kill a process subtree: `taskkill /T /F` on Windows (whole tree), SIGTERM
 * elsewhere. Best-effort — the child may already have exited. */
function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F']) } catch { /* best-effort */ }
  } else {
    try { process.kill(pid, 'SIGTERM') } catch { /* best-effort */ }
  }
}

/** Whether to stream pnpm's live output line-by-line (Debug). On with
 * `DSH_PNPM_TRACE=1`, or when any level env pins a sink to `debug`. Off by
 * default so a normal run keeps a small, summary-only log footprint. */
function tracePnpm(): boolean {
  if (process.env.DSH_PNPM_TRACE === '1') return true
  return [process.env.DSH_LOG_CONSOLE_LEVEL, process.env.DSH_LOG_LEVEL, process.env.DSH_LOG_FILE_LEVEL]
    .some(level => level === 'debug')
}