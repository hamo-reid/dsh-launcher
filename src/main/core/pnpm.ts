/** Run pnpm in a directory, capturing output. Async (non-blocking the UI thread). */

import { spawn } from 'node:child_process'

export interface PnpmResult {
  ok: boolean
  /** Trimmed combined stdout+stderr. */
  text: string
}

/** Run `pnpm <args>` with cwd, resolving on process exit. */
export function runPnpm(cwd: string, args: readonly string[]): Promise<PnpmResult> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', [...args], {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    let out = ''
    child.stdout?.on('data', (data: Buffer) => { out += String(data) })
    child.stderr?.on('data', (data: Buffer) => { out += String(data) })
    child.on('error', (error) => resolve({ ok: false, text: error.message }))
    child.on('close', (code) => resolve({ ok: code === 0, text: out.trim() }))
  })
}