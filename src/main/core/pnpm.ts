/** Run pnpm in a directory, capturing output. Async (non-blocking the UI thread). */

import { spawn } from 'node:child_process'
import { logger } from './logger.ts'

export interface PnpmResult {
  ok: boolean
  /** Trimmed combined stdout+stderr. */
  text: string
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
      logger.debug(`pnpm done (${code === 0 ? 'ok' : `exit ${String(code)}`}) @ ${cwd}`)
      resolve({ ok: code === 0, text: out.trim() })
    })
  })
}