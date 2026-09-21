/**
 * The store's version index.
 *
 * The property worth locking is that versions keep the order `plugins.list()`
 * returned them in: callers read the LAST entry as the newest archive (the store
 * writes versions in ascending order), so a re-grouping that reordered them would
 * silently change what "latest" means.
 */
import { describe, expect, it } from 'vitest'
import { toStoreMap } from './storeMap.ts'

describe('toStoreMap', () => {
  it('groups versions by package name', () => {
    const map = toStoreMap([
      { name: 'a', version: '1.0.0' },
      { name: 'b', version: '2.0.0' },
      { name: 'a', version: '1.1.0' },
    ])
    expect([...map.keys()]).toEqual(['a', 'b'])
    expect(map.get('a')).toEqual(['1.0.0', '1.1.0'])
    expect(map.get('b')).toEqual(['2.0.0'])
  })

  it('keeps the given order, so the last entry stays the newest', () => {
    const map = toStoreMap([
      { name: 'a', version: '1.0.0' },
      { name: 'a', version: '2.0.0' },
      { name: 'a', version: '3.0.0' },
    ])
    expect(map.get('a')?.at(-1)).toBe('3.0.0')
  })

  it('is empty for nothing', () => {
    expect(toStoreMap([]).size).toBe(0)
  })
})
