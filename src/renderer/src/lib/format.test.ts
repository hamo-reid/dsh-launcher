/**
 * The renderer's display formatting.
 *
 * `fmtBytes` is the one with real behaviour to lock: it is now the single
 * implementation behind the plugin cards, the version lists and the trash panel,
 * and the trash panel's own copy capped at MB and always printed a decimal. The
 * boundaries below are the ones that differ.
 */
import { describe, expect, it } from 'vitest'
import { fmtBytes, fmtDate, fmtDateTime, fmtNum } from './format.ts'

describe('fmtBytes', () => {
  it('prints whole bytes below a kilobyte', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(1023)).toBe('1023 B')
  })

  it('steps up a unit at exactly 1024', () => {
    expect(fmtBytes(1024)).toBe('1.0 KB')
  })

  it('keeps one decimal below 100 units', () => {
    expect(fmtBytes(1536)).toBe('1.5 KB')
    expect(fmtBytes(99 * 1024)).toBe('99.0 KB')
  })

  it('drops the decimal at 100 units and above', () => {
    expect(fmtBytes(100 * 1024)).toBe('100 KB')
    expect(fmtBytes(150 * 1024)).toBe('150 KB')
  })

  it('keeps stepping units past a megabyte', () => {
    expect(fmtBytes(1024 * 1024)).toBe('1.0 MB')
    // The trash panel's former copy stopped at MB and would say "2048.0 MB" here.
    expect(fmtBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB')
  })

  it('stops at the largest unit rather than inventing one', () => {
    expect(fmtBytes(5 * 1024 ** 4)).toBe('5.0 TB')
    expect(fmtBytes(5000 * 1024 ** 4)).toBe('5000 TB')
  })
})

describe('date formatting', () => {
  it('renders a valid instant as a non-empty, locale-shaped string', () => {
    // Asserting the shape rather than the text: the output follows the system
    // locale, which the tests must not pin.
    expect(fmtDate('2026-09-21T12:00:00.000Z')).toMatch(/2026/)
    expect(fmtDateTime('2026-09-21T12:00:00.000Z')).toMatch(/2026/)
  })

  it('reports an unparseable instant as empty rather than "Invalid Date"', () => {
    expect(fmtDate('not-a-date')).toBe('')
    expect(fmtDateTime('not-a-date')).toBe('')
  })
})

describe('fmtNum', () => {
  it('thousands-separates', () => {
    expect(fmtNum(1234567)).toMatch(/1.234.567|1,234,567/)
    expect(fmtNum(42)).toBe('42')
  })

  it('keeps a fractional part, as Intl does by default', () => {
    expect(fmtNum(1234.6)).toMatch(/1.234,6|1,234\.6/)
  })
})
