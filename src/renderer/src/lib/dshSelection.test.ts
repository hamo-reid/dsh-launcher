/**
 * The Profile/Run pages' remembered dsh choice. The load-bearing property is
 * that neither direction ever throws: a page must not break because storage is
 * unavailable (private mode, blocked site data) — losing a preference is fine.
 */
import { describe, expect, it } from 'vitest'
import { PROFILE_DSH_KEY, RUN_DSH_KEY, readDshSelection, saveDshSelection } from './dshSelection.ts'

/** An in-memory stand-in for the two Storage methods the helpers use. */
function fakeStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
  }
}

describe('readDshSelection', () => {
  it('returns the stored id', () => {
    const storage = fakeStorage()
    storage.setItem(PROFILE_DSH_KEY, '/x/dsh.cmd')
    expect(readDshSelection(PROFILE_DSH_KEY, storage)).toBe('/x/dsh.cmd')
  })

  it('is empty when nothing was ever stored', () => {
    expect(readDshSelection(PROFILE_DSH_KEY, fakeStorage())).toBe('')
  })

  it('is empty — not a throw — when storage refuses to read', () => {
    const blocked = { getItem: (): string | null => { throw new Error('blocked') } }
    expect(readDshSelection(PROFILE_DSH_KEY, blocked)).toBe('')
  })
})

describe('saveDshSelection', () => {
  it('writes under the given key', () => {
    const storage = fakeStorage()
    saveDshSelection(RUN_DSH_KEY, '/y/dsh.cmd', storage)
    expect(storage.getItem(RUN_DSH_KEY)).toBe('/y/dsh.cmd')
  })

  it('swallows a storage failure', () => {
    const full = { setItem: (): void => { throw new Error('quota exceeded') } }
    expect(() => saveDshSelection(RUN_DSH_KEY, '/y/dsh.cmd', full)).not.toThrow()
  })
})

describe('the two pages', () => {
  it('remember independently, so switching one leaves the other alone', () => {
    const storage = fakeStorage()
    saveDshSelection(PROFILE_DSH_KEY, 'profile-dsh', storage)
    saveDshSelection(RUN_DSH_KEY, 'run-dsh', storage)
    expect(readDshSelection(PROFILE_DSH_KEY, storage)).toBe('profile-dsh')
    expect(readDshSelection(RUN_DSH_KEY, storage)).toBe('run-dsh')

    saveDshSelection(RUN_DSH_KEY, 'other', storage)
    expect(readDshSelection(PROFILE_DSH_KEY, storage)).toBe('profile-dsh')
    expect(readDshSelection(RUN_DSH_KEY, storage)).toBe('other')
  })
})
