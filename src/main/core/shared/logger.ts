/**
 * Main-process logger, layered on winston + daily-rotate file rotation.
 *
 * - console: human-readable (dev visibility), mirrored with a `[dsh]` prefix.
 * - file: JSON-structured, one file per day (`main-<DATE>.log`), retaining
 *   KEEP_DAYS days via the rotating sink's `maxFiles` — so each line is both
 *   greppable and ready for a future log collector.
 *
 * The public `logger.{debug,info,warn,error}(message, extra?)` surface is
 * unchanged from the previous zero-dep logger, so existing call sites (70+) were
 * not touched. `extra` accepts either a Node `Error` (serialised into `err` with
 * its stack/code), a plain object (spread as structured metadata), or a string
 * (recorded as `detail`) — fixing the old signature where a second object was
 * silently stringified to `[object Object]`.
 *
 * The two sinks are throttled independently: the console honours
 * `DSH_LOG_CONSOLE_LEVEL` (legacy `DSH_LOG_LEVEL` fallback, default `debug`),
 * while the rotating FILE sink defaults to full `debug` capture
 * (`DSH_LOG_FILE_LEVEL` to override), so a quiet terminal never costs you a greppable archive. Domain-scoped logging is available via {@link child} — e.g.
 * `child('pnpm')` — which stamps every line with `{ domain }` in the JSON file
 * and a bold `[domain]` tag on the console.
 * The file sink is attached by {@link initLogger} once the logs dir is known;
 * calls before that hit only the console and are harmless.
 */

import { createLogger, format, transports, type Logger } from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import { mkdirSync } from 'node:fs'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Severity ladder — debug lowest, so clamping the level at `debug` shows all. */
const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }
const KEEP_DAYS = 7

// ── per-sink severity thresholds ─────────────────────────────────────────────
// The two sinks are throttled independently: CONSOLE honours DSH_LOG_CONSOLE_LEVEL
// (falling back to the legacy DSH_LOG_LEVEL, default `debug`), while the rotating
// FILE sink defaults to full `debug` capture so nothing is lost on disk even when
// the terminal is set to `info`. Both overridable via their own env var.
const CONSOLE_LEVEL = process.env.DSH_LOG_CONSOLE_LEVEL ?? process.env.DSH_LOG_LEVEL ?? 'debug'
const FILE_LEVEL = process.env.DSH_LOG_FILE_LEVEL ?? 'debug'

// ── ANSI colour-grading for the console sink ─────────────────────────────────
// A line is split into four visual segments so a live `pnpm dev` tail reads at a
// glance: body `[dsh]` (bold), timestamp (grey), level badge (severity colour),
// then the message (default foreground). The level badge and any error/stack
// block use the common ladder below. The rotating FILE sink emits plain JSON and
// is untouched.
const C_RESET = '\x1b[0m'
/** Whether ANSI is acceptable here. Electron + modern Win10/11 consoles are
 * VT-aware, so color on by default; `NO_COLOR`, `TERM=dumb` disable it and
 * `FORCE_COLOR` forces it back on. */
function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  if (process.env.TERM === 'dumb') return false
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true
  return true
}
const USE_COLOR = colorEnabled()
/** Wrap `s` in an ANSI SGR code (`1;31` = bold red) when color is enabled. */
const paint = (code: string, s: string): string => (USE_COLOR ? `\x1b[${code}m${s}${C_RESET}` : s)

/** Common severity colour ladder — debug=cyan, info=green, warn=yellow, error=red. */
const LEVEL_FG: Record<LogLevel, string> = {
  error: '31',
  warn: '33',
  info: '32',
  debug: '36',
}

let logsDir = ''

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function timeStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

function indent(text: string): string {
  return text.split('\n').map(line => `    ${line}`).join('\n')
}

/** The renderer-facing timestamp (local-time, ms), keeping file output stable. */
const ts = format.timestamp({ format: () => timeStamp(new Date()) })

/** Normalise the caller's `extra` arg (Error | object | string) into info metadata. */
function toMeta(extra: unknown): Record<string, unknown> {
  if (extra === undefined) return {}
  if (extra instanceof Error) {
    const err: Record<string, unknown> = { message: extra.message, stack: extra.stack ?? extra.message }
    const code = (extra as { code?: unknown }).code
    if (code !== undefined) err.code = code
    return { err }
  }
  if (typeof extra === 'object' && extra !== null) return extra as Record<string, unknown>
  return { detail: String(extra) }
}

function consoleFormat(): ReturnType<typeof format.combine> {
  return format.combine(
    ts,
    format.splat(),
    format.printf((info) => {
      const { message, level, timestamp, err, detail, domain } = info as Record<string, unknown>
      const fg = LEVEL_FG[level as LogLevel]
      // body (bold) · timestamp (grey) · [domain] (bold, when a child logger tags it) · level badge (severity colour) · message (default)
      const segs = [`${paint('1', '[dsh]')} ${paint('90', `[${String(timestamp)}]`)}`]
      if (domain !== undefined && domain !== '') segs.push(paint('1', `[${String(domain)}]`))
      segs.push(paint(`1;${fg}`, `[${String(level).toUpperCase()}]`))
      const head = `${segs.join(' ')} ${String(message)}`
      if (err !== undefined && err !== null) {
        const e = err as { stack?: string; message?: string }
        return `${head}\n${paint(fg, indent(e.stack ?? e.message ?? String(err)))}`
      }
      if (detail !== undefined) {
        return `${head}\n${paint(fg, indent(String(detail)))}`
      }
      return head
    }),
  )
}

function fileFormat(): ReturnType<typeof format.combine> {
  return format.combine(ts, format.splat(), format.json())
}

/** Build a fresh console-only logger (recreated after {@link closeLoggerForTest}). */
function consoleOnlyLogger(): Logger {
  return createLogger({
    levels: LEVELS,
    level: CONSOLE_LEVEL,
    transports: [new transports.Console({ format: consoleFormat() })],
  })
}

let loggerRef: Logger = consoleOnlyLogger()

function emit(level: LogLevel, message: string, extra?: unknown, domain?: string): void {
  try {
    loggerRef.log({
      level,
      message,
      ...(domain !== undefined && domain !== '' ? { domain } : {}),
      ...toMeta(extra),
    })
  } catch {
    // never let logging break the app
  }
}

/** Point the logger at a logs directory and attach the rotating file sink. */
export function initLogger(dir: string): void {
  logsDir = dir
  try {
    mkdirSync(logsDir, { recursive: true })
  } catch {
    logsDir = '' // fall back to console-only rather than crash on startup
  }
  if (logsDir === '') return
  const rotate = new DailyRotateFile({
    dirname: logsDir,
    filename: 'main-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: `${KEEP_DAYS}d`,
    zippedArchive: false, // keep plain text so the day's log stays greppable
    format: fileFormat(),
    level: FILE_LEVEL,
  })
  // A failing transport must never become an unhandled 'error' in the main
  // process (e.g. the logs dir was deleted under the app).
  rotate.on('error', () => {})
  loggerRef.add(rotate)
}

/** The configured logs directory (`''` before {@link initLogger}). */
export function logsDirectory(): string {
  return logsDir
}

/** The `logger.*` surface (optionally tagged with a `domain` for routing/grep). */
export interface LoggerApi {
  debug: (message: string, extra?: unknown) => void
  info: (message: string, extra?: unknown) => void
  warn: (message: string, extra?: unknown) => void
  error: (message: string, extra?: unknown) => void
}

function apiFor(domain: string | undefined): LoggerApi {
  return {
    debug: (message, extra) => emit('debug', message, extra, domain),
    info: (message, extra) => emit('info', message, extra, domain),
    warn: (message, extra) => emit('warn', message, extra, domain),
    error: (message, extra) => emit('error', message, extra, domain),
  }
}

/** Convenience: one line at an explicit level. */
export function log(level: LogLevel, message: string, extra?: unknown): void {
  emit(level, message, extra)
}

/** The global logger (no domain tag). Same shape the 70+ existing call sites use. */
export const logger: LoggerApi = apiFor(undefined)

/** A domain-scoped view of the logger: every line is stamped `{ domain }` in the
 * JSON file and shown as a bold `[domain]` tag on the console — cheap routing
 * for sub-systems (e.g. `child('pnpm')`) without a separate file sink. */
export function child(domain: string): LoggerApi {
  return apiFor(domain)
}

/** Print a multi-line startup banner straight to the terminal — no `[dsh]` /
 * level decoration, so the launch logo reads clean against the log stream.
 * `code` is the ANSI SGR foreground for the whole banner (default bright cyan);
 * colouring is dropped entirely when the terminal doesn't support it. Logger-
 * aware build of an ASCII brand signature at app start. */
export function printBanner(lines: readonly string[], code = '96'): void {
  console.log(paint(code, lines.join('\n')))
}

/**
 * Test-only: close the file sink (releasing the open log handle) and reset to a
 * fresh console-only logger so subsequent tests stay isolated on Windows, where
 * deleting a directory that holds an open file raises EPERM.
 */
export function closeLoggerForTest(): void {
  try {
    loggerRef.close()
  } catch {
    // already closed / no transports — ignore
  }
  loggerRef = consoleOnlyLogger()
  logsDir = ''
}