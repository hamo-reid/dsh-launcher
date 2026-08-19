/** Run pnpm in a directory, capturing output. Async (non-blocking the UI thread). */

import { spawn } from 'node:child_process'
import { logger } from './logger.ts'

export interface PnpmResult {
  ok: boolean
  /** Trimmed combined stdout+stderr. */
  text: string
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
    const child = spawn('pnpm', [...args], {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    let out = ''
    child.stdout?.on('data', (data: Buffer) => { out += String(data) })
    child.stderr?.on('data', (data: Buffer) => { out += String(data) })
    child.on('error', (error) => { logger.warn(`pnpm failed to run: ${error.message}`); resolve({ ok: false, text: error.message }) })
    child.on('close', (code) => {
      const ok = code === 0
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