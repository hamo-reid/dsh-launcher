/**
 * Minimal main-process logger — writes `~/dsh-launcher/logs/main-<date>.log`
 * (one file per day), prunes anything older than a week at startup, and
 * mirrors every line to the console (dev visibility). Zero dependencies
 * (`node:fs` only), fitting the repo's self-contained, no-native-dep style.
 *
 * The sink is initialized once with {@link initLogger} once the data dir is
 * known; until then calls only hit the console and are harmless.
 */

import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

let logsDir = ''
const KEEP_DAYS = 7
const FILE_PREFIX = 'main-'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function dateStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function timeStamp(d: Date): string {
  return `${dateStamp(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

/** Point the logger at a logs directory (make it, prune stale files). Idempotent. */
export function initLogger(dir: string): void {
  logsDir = dir
  try {
    mkdirSync(logsDir, { recursive: true })
  } catch {
    logsDir = '' // fall back to console-only rather than crash on startup
  }
  pruneOld()
}

/** Remove `main-YYYY-MM-DD.log` files older than KEEP_DAYS. */
function pruneOld(): void {
  if (logsDir === '') return
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS)
  const cutoffDay = dateStamp(cutoff)
  try {
    for (const file of readdirSync(logsDir)) {
      if (!file.startsWith(FILE_PREFIX) || !file.endsWith('.log')) continue
      const day = file.slice(FILE_PREFIX.length, -'.log'.length)
      if (day < cutoffDay) rmSync(join(logsDir, file), { force: true })
    }
  } catch {
    // readdir raced a cleanup or dir vanished — skip pruning this run
  }
}

function indent(text: string): string {
  return text.split('\n').map(line => `    ${line}`).join('\n')
}

function format(level: LogLevel, message: string, error?: unknown): string {
  const head = `[${timeStamp(new Date())}] [${level.toUpperCase()}] ${message}`
  if (error === undefined) return `${head}\n`
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  return `${head}\n${indent(detail)}\n`
}

/** Write one log line: console mirror + append to today's file. */
export function log(level: LogLevel, message: string, error?: unknown): void {
  const consoleFn = level === 'error' ? console.error
    : level === 'warn' ? console.warn
      : level === 'debug' ? console.debug
        : console.log
  try { consoleFn('[dsh]', message, error ?? '') } catch { /* ignore */ }

  if (logsDir === '') return
  try {
    appendFileSync(join(logsDir, `${FILE_PREFIX}${dateStamp(new Date())}.log`), format(level, message, error))
  } catch {
    // disk failure — never let logging break the app
  }
}

export const logger = {
  debug: (message: string, error?: unknown): void => log('debug', message, error),
  info: (message: string, error?: unknown): void => log('info', message, error),
  warn: (message: string, error?: unknown): void => log('warn', message, error),
  error: (message: string, error?: unknown): void => log('error', message, error),
}

/** The configured logs directory (`''` before {@link initLogger}). */
export function logsDirectory(): string {
  return logsDir
}