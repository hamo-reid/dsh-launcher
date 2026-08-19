/** Run pnpm in a directory, capturing output. Async (non-blocking the UI thread).
 *
 * Runs pnpm on Electron's OWN bundled Node — `process.execPath` under
 * `ELECTRON_RUN_AS_NODE` is a plain Node runtime — instead of relying on a
 * system `node` and a global pnpm from PATH. That way a user without Node/pnpm
 * (or with a mismatched pnpm version) still works, and the pnpm version is
 * locked to the app's dependency. */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { logger } from './logger.ts'

const require = createRequire(import.meta.url)

export interface PnpmResult {
  ok: boolean
  /** Trimmed combined stdout+stderr. */
  text: string
}

/** pnpm's JS entry, resolved from node_modules (inside the packaged asar at
 * runtime). Cached. Throws if pnpm is not installed. */
let pnpmEntry: string | null = null
function resolvePnpmEntry(): string {
  // pnpm's "exports" only maps "." → "./package.json", so resolving the bin via a
  // package subpath throws ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the package root
  // through ".", then load bin/pnpm.cjs by its absolute file path — no exports check.
  pnpmEntry ??= join(dirname(require.resolve('pnpm')), 'bin', 'pnpm.cjs')
  return pnpmEntry
}

/** Content-level success check: pnpm may exit non-zero yet still have installed
 * (e.g. it emits `ERR_PNPM_IGNORED_BUILDS` and exits 1, but every package is
 * present in the output). Key on the install-output markers, not the exit code. */
export function installSucceeded(text: string): boolean {
  return /added \d+|Done in/.test(text)
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

/** Run `pnpm <args>` with cwd, resolving on process exit. */
export function runPnpm(cwd: string, args: readonly string[]): Promise<PnpmResult> {
  return new Promise((resolve) => {
    logger.debug(`pnpm ${args.join(' ')} @ ${cwd}`)
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(process.execPath, [resolvePnpmEntry(), ...args], {
        cwd,
        // Absolute execPath + array args: no shell, so a spacey packaged exe name
        // or a spacey pnpm-entry path is passed correctly (no quoting hazards).
        shell: false,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    } catch (error) {
      logger.error('pnpm failed to start', error)
      resolve({ ok: false, text: error instanceof Error ? error.message : String(error) })
      return
    }
    let out = ''
    child.stdout?.on('data', (data: Buffer) => { out += String(data) })
    child.stderr?.on('data', (data: Buffer) => { out += String(data) })
    child.on('error', (error) => { logger.warn(`pnpm failed to run: ${error.message}`); resolve({ ok: false, text: error.message }) })
    child.on('close', (code) => {
      // Real installs (even when exit != 0, e.g. ignored build scripts) count as ok.
      const ok = code === 0 || installSucceeded(out)
      const tail = summarizePnpmOut(out)
      if (ok) {
        logger.debug(`pnpm ok @ ${cwd}${tail !== '' ? `\n${tail}` : ''}`)
      } else {
        logger.warn(`pnpm failed (exit ${String(code)}) @ ${cwd}`)
        if (tail !== '') logger.warn(`pnpm output:\n${tail}`)
      }
      resolve({ ok, text: out.trim() })
    })
  })
}