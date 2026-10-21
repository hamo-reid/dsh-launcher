/**
 * winston-backed logger: initLogger attaches the rotating file sink, lines land
 * as JSON in today's `main-<DATE>.log`, an Error `extra` is serialised into
 * `err`, an object `extra` spreads as metadata, and stale files are pruned by
 * the rotating sink's `maxFiles`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { child, closeLoggerForTest, initLogger, logger, logsDirectory, printBanner } from './logger.ts'

let dirs: string[] = []

afterEach(async () => {
  // Release the rotating transport's open file handle before deleting the dir
  // (Windows raises EPERM when a directory holds an open file), and reset to a
  // fresh console-only logger so the next test starts clean.
  closeLoggerForTest()
  // Let the rotating sink flush its final write before the temp dir is removed
  // (otherwise its late `open` hits ENOENT and surfaces as an unhandled error).
  await new Promise(r => setTimeout(r, 80))
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function mk(): string {
  const d = mkdtempSync(join(tmpdir(), 'pm-logger-'))
  dirs.push(d)
  return d
}

/** Today's most-recent `main-*.log`, or a look-up helper for polling. */
function todayLog(dir: string): string | undefined {
  const f = readdirSync(dir).filter(x => x.startsWith('main-') && x.endsWith('.log')).sort().at(-1)
  return f === undefined ? undefined : join(dir, f)
}

/** Poll a predicate until it holds (the rotating sink writes asynchronously). */
async function until(pred: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - start > ms) throw new Error('timed out polling the log sink')
    await new Promise(r => setTimeout(r, 25))
  }
}

/** What the console sink writes for one call. winston writes through
 * `console._stdout` (Node maps it to `process.stdout`), which a test runner may
 * have swapped, so the spy goes on whichever stream the transport actually uses. */
function captureConsole(fn: () => void): string {
  type Writable = { write: (chunk: string | Uint8Array) => unknown }
  const chunks: string[] = []
  const globalConsole = console as unknown as { _stdout?: Writable; _stderr?: Writable }
  const targets = new Set<Writable>()
  for (const stream of [process.stdout, process.stderr, globalConsole._stdout, globalConsole._stderr]) {
    if (stream !== undefined && typeof stream.write === 'function') targets.add(stream)
  }
  const spies = [...targets].map(stream => vi.spyOn(stream, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk))
    return true
  }))
  try {
    fn()
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
  return chunks.join('')
}

/** The banner is one write followed by a newline of its own, so the next log line
 * can never be decoded together with the logo (Windows terminals pick one code
 * page per write, and the logo is the part that gives up). */
describe('printBanner', () => {
  it('ends with its own newline so the next log line is a separate write', () => {
    // console.log only appends \n when the text does not already end with one.
    const written = captureConsole(() => { printBanner(['LOGO']) })
    expect(written.endsWith('LOGO\n\n')).toBe(true)
  })
})

describe('logger', () => {
  it('logsDirectory is empty before init and set after', () => {
    expect(logsDirectory()).toBe('')
    initLogger(mk())
    expect(logsDirectory()).not.toBe('')
  })

  it('writes one JSON line to today log file via logger.info', async () => {
    const d = mk()
    initLogger(d)
    logger.info('hello world')
    await until(() => todayLog(d) !== undefined)
    const file = todayLog(d)!
    await until(() => readFileSync(file, 'utf8').includes('hello world'))
    const obj = JSON.parse(readFileSync(file, 'utf8'))
    expect(obj.level).toBe('info')
    expect(obj.message).toBe('hello world')
    expect(typeof obj.timestamp).toBe('string')
  })

  it('serialises an Error extra into err with its stack', async () => {
    const d = mk()
    initLogger(d)
    logger.error('boom', new Error('detail'))
    await until(() => todayLog(d) !== undefined)
    await until(() => readFileSync(todayLog(d)!, 'utf8').includes('boom'))
    const obj = JSON.parse(readFileSync(todayLog(d)!, 'utf8'))
    expect(obj.level).toBe('error')
    expect(obj.message).toBe('boom')
    expect(obj.err.message).toBe('detail')
    expect(obj.err.stack).toContain('Error: detail')
  })

  it('spreads an object extra as structured metadata (not [object Object])', async () => {
    const d = mk()
    initLogger(d)
    logger.info('app starting', { version: 'v0.2.0-beta1' })
    await until(() => todayLog(d) !== undefined)
    await until(() => readFileSync(todayLog(d)!, 'utf8').includes('app starting'))
    const obj = JSON.parse(readFileSync(todayLog(d)!, 'utf8'))
    expect(obj.version).toBe('v0.2.0-beta1')
  })

  it('child(\'domain\') stamps a domain field into the file JSON', async () => {
    const d = mk()
    initLogger(d)
    child('pnpm').info('resolving deps', { count: 3 })
    await until(() => todayLog(d) !== undefined)
    await until(() => readFileSync(todayLog(d)!, 'utf8').includes('resolving deps'))
    const obj = JSON.parse(readFileSync(todayLog(d)!, 'utf8'))
    expect(obj.domain).toBe('pnpm')
    expect(obj.count).toBe(3)
    expect(obj.level).toBe('info')
  })

  it('logs only to the console when no dir is configured', () => {
    // afterEach already reset to a console-only logger; the call must not throw.
    expect(() => logger.warn('no-dir', 'x')).not.toThrow()
  })

  it('prints a failure code on the console line, and nothing when there is none', () => {
    // The console sink prints the message and drops unstructured metadata, so a
    // refusal used to read `ipc fail: ext:skillList` with the reason only in the
    // file JSON — the one line a reader greps is the one that hid its own cause.
    const withCode = captureConsole(() => { logger.debug('ipc fail: ext:skillList', { code: 'profile.notFound' }) })
    expect(withCode).toContain('ipc fail: ext:skillList (profile.notFound)')
    // Control: the suffix belongs to the code, not to every line.
    const without = captureConsole(() => { logger.debug('ipc fail: ext:skillList') })
    expect(without).toContain('ipc fail: ext:skillList')
    expect(without).not.toContain('(')
  })

  it('initLogger attaches the sink, writes today, and leaves non-log files alone', async () => {
    const d = mk()
    writeFileSync(join(d, 'main-2020-01-01.log'), 'old')
    writeFileSync(join(d, 'other.txt'), 'keep')
    initLogger(d)
    logger.info('tick')
    // assert today's line actually lands (the rotating sink attaches + writes).
    await until(() => {
      const f = todayLog(d)
      return f !== undefined && readFileSync(f, 'utf8').includes('tick')
    })
    // Retention of over-aged rotations is delegated to the sink's own `maxFiles`
    // (it prunes old rotations on roll-over), so only non-log file survival and
    // the today write are asserted here.
    expect(existsSync(join(d, 'other.txt'))).toBe(true)
    expect(existsSync(join(d, 'main-2020-01-01.log'))).toBe(true)
  })
})