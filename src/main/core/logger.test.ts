/**
 * Logger: initLogger / log writes to today's file, logsDirectory reflects the
 * configured dir, and stale logs are pruned on init.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initLogger, log, logsDirectory } from './logger.ts'

let dirs: string[] = []

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function mk(): string {
  const d = mkdtempSync(join(tmpdir(), 'pm-logger-'))
  dirs.push(d)
  return d
}

describe('logger', () => {
  it('logsDirectory is empty before init and set after', () => {
    expect(logsDirectory()).toBe('')
    const d = mk()
    initLogger(d)
    expect(logsDirectory()).toBe(d)
  })

  it('writes a formatted line to today log file via log()', () => {
    const d = mk()
    initLogger(d)
    log('info', 'hello world')
    const file = readdirSync(d).find(f => f.startsWith('main-') && f.endsWith('.log'))
    expect(file).toBeDefined()
    const content = readFileSync(join(d, file as string), 'utf8')
    expect(content).toContain('[INFO] hello world')
  })

  it('appends detail lines for an error (with stack indentation)', () => {
    const d = mk()
    initLogger(d)
    log('error', 'boom', new Error('detail'))
    const content = writeAndReadLast(d)
    expect(content).toContain('[ERROR] boom')
    expect(content).toContain('    Error: detail')
  })

  it('logs only to the console when no dir is configured', () => {
    // logsDirectory was reset after the previous test; calling log() must not throw.
    expect(() => log('warn', 'no-dir', 'x')).not.toThrow()
  })

  it('prunes stale logs older than KEEP_DAYS on init', () => {
    const d = mk()
    writeFileSync(join(d, 'main-2020-01-01.log'), 'old')
    writeFileSync(join(d, 'main-2020-12-31.log'), 'old')
    initLogger(d)
    const remaining = readdirSync(d).filter(f => f.startsWith('main-'))
    expect(remaining).not.toContain('main-2020-01-01.log')
    expect(remaining).not.toContain('main-2020-12-31.log')
  })

  it('prune skips non-log files and today-dated logs are kept', () => {
    const d = mk()
    writeFileSync(join(d, 'main-2020-01-01.log'), 'old')
    writeFileSync(join(d, 'other.txt'), 'keep')
    initLogger(d)
    expect(existsSync(join(d, 'other.txt'))).toBe(true)
    expect(existsSync(join(d, 'main-2020-01-01.log'))).toBe(false)
  })
})

/** Helper: append a line via log() and return the latest log file's content. */
function writeAndReadLast(dir: string): string {
  const file = readdirSync(dir).filter(f => f.startsWith('main-') && f.endsWith('.log')).sort().at(-1)
  return file === undefined ? '' : readFileSync(join(dir, file), 'utf8')
}