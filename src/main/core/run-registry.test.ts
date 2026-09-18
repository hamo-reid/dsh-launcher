/** Tests for the pure multi-run registry helpers (id generation, the
 * single-instance-per-profile guard and the duration label). */
import { describe, expect, it } from 'vitest'
import { formatRunDuration, hasRun, nextRunId } from './run-registry.ts'

describe('nextRunId', () => {
  it('builds a stable `<profile>#<seq>` id', () => {
    expect(nextRunId('my-web', 3)).toBe('my-web#3')
  })

  it('is collision-free for two runs started in the same millisecond', () => {
    expect(nextRunId('my-web', 1)).not.toBe(nextRunId('my-web', 2))
  })
})

describe('hasRun', () => {
  it('detects an existing run of the same profile under the same dsh', () => {
    expect(hasRun([{ dshId: 'd1', profile: 'a' }, { dshId: 'd1', profile: 'b' }], 'd1', 'b')).toBe(true)
  })

  it('allows the same profile name under a different dsh', () => {
    expect(hasRun([{ dshId: 'd1', profile: 'a' }], 'd2', 'a')).toBe(false)
  })

  it('allows a different profile to run concurrently', () => {
    expect(hasRun([{ dshId: 'd1', profile: 'a' }], 'd1', 'b')).toBe(false)
  })

  it('is false for an empty registry', () => {
    expect(hasRun([], 'd1', 'a')).toBe(false)
  })
})

describe('formatRunDuration', () => {
  it('formats seconds only', () => {
    expect(formatRunDuration(12_000)).toBe('12 秒')
  })

  it('formats minutes and seconds', () => {
    expect(formatRunDuration(3 * 60_000 + 12_000)).toBe('3 分 12 秒')
  })

  it('formats hours, minutes and seconds', () => {
    expect(formatRunDuration(3600_000 + 5 * 60_000 + 7_000)).toBe('1 时 5 分 7 秒')
  })

  it('clamps negative elapsed to zero', () => {
    expect(formatRunDuration(-500)).toBe('0 秒')
  })
})
