/**
 * The bookkeeping the five hand-rolled caches each re-derived, and none of them
 * tested: TTL expiry, the over-budget trim, and `forget`.
 *
 * The trim order is the subtle one. Entries are dropped in insertion order, NOT
 * most-recently-written order: a key is an input signature, so a changed input is
 * a new key and the entry it replaced is stale garbage that should go first.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKeyedCache } from './keyed-cache.ts'

afterEach(() => { vi.useRealTimers() })

describe('createKeyedCache', () => {
  it('computes on a miss and serves the stored value on a hit', () => {
    const cache = createKeyedCache<string>()
    const compute = vi.fn(() => 'value')
    expect(cache.get('k', compute)).toBe('value')
    expect(cache.get('k', compute)).toBe('value')
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('recomputes when refresh is asked for', () => {
    const cache = createKeyedCache<string>()
    const compute = vi.fn(() => 'value')
    cache.get('k', compute)
    cache.get('k', compute, { refresh: true })
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it('keeps an entry forever by default', () => {
    vi.useFakeTimers()
    const cache = createKeyedCache<string>()
    cache.set('k', 'value')
    vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000)
    expect(cache.peek('k')).toBe('value')
  })

  it('expires an entry once its TTL has passed', () => {
    vi.useFakeTimers()
    const cache = createKeyedCache<string>({ ttlMs: 1000 })
    cache.set('k', 'value')
    vi.advanceTimersByTime(999)
    expect(cache.peek('k')).toBe('value')
    vi.advanceTimersByTime(1)
    expect(cache.peek('k')).toBeUndefined()
  })

  it('honours a per-entry TTL override', () => {
    vi.useFakeTimers()
    const cache = createKeyedCache<string>({ ttlMs: 1000 })
    cache.set('short', 'value', { ttlMs: 10 })
    cache.set('long', 'value')
    vi.advanceTimersByTime(10)
    expect(cache.peek('short')).toBeUndefined()
    expect(cache.peek('long')).toBe('value')
  })

  it('never computes from peek', () => {
    const cache = createKeyedCache<string>()
    expect(cache.peek('missing')).toBeUndefined()
  })

  it('drops the oldest entry when it goes over budget', () => {
    const cache = createKeyedCache<number>({ max: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    expect(cache.peek('a')).toBeUndefined()
    expect(cache.peek('b')).toBe(2)
    expect(cache.peek('c')).toBe(3)
  })

  it('keeps a re-stored key at its original position, so stale garbage goes first', () => {
    const cache = createKeyedCache<number>({ max: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    // Re-storing `a` is the caller saying "this signature is current again" — but
    // it must not buy the entry a longer life than the ones behind it.
    cache.set('a', 11)
    cache.set('c', 3)
    expect(cache.peek('a')).toBeUndefined()
    expect(cache.peek('b')).toBe(2)
    expect(cache.peek('c')).toBe(3)
  })

  it('forgets one entry, or every entry', () => {
    const cache = createKeyedCache<number>()
    cache.set('a', 1)
    cache.set('b', 2)
    cache.forget('a')
    expect(cache.peek('a')).toBeUndefined()
    expect(cache.peek('b')).toBe(2)
    cache.forget()
    expect(cache.peek('b')).toBeUndefined()
  })
})
