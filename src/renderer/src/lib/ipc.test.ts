import { describe, expect, it, vi } from 'vitest'
import { apiErrorText } from './ipc.ts'

// Deterministic i18next stub: a known code resolves to text, anything else falls
// back to the defaultValue passed by apiErrorText (mirroring real i18next).
const known = vi.hoisted(() => ({ 'errors.foo': 'Foo failed' }))
vi.mock('i18next', () => ({
  default: {
    t: (key: string, opts?: { defaultValue?: unknown }): string => {
      const hit = (known as Record<string, string>)[key]
      if (hit !== undefined) return hit
      return typeof opts?.defaultValue === 'string' ? opts.defaultValue : key
    },
  },
}))

describe('apiErrorText', () => {
  it('returns the localized text for a known code', () => {
    expect(apiErrorText({ ok: false, code: 'foo', error: 'raw' })).toBe('Foo failed')
  })

  it('falls back to the detail param when the code is not localized', () => {
    expect(apiErrorText({ ok: false, code: 'nope', params: { detail: 'detail-err' }, error: 'raw' })).toBe('detail-err')
  })

  it('falls back to the raw error when there is neither locale nor detail', () => {
    expect(apiErrorText({ ok: false, code: 'nope', error: 'raw message' })).toBe('raw message')
  })

  it('handles a params array without crashing (uses it only for the error text)', () => {
    // An array param has no .detail, so it falls through to the raw error.
    expect(apiErrorText({ ok: false, code: 'nope', params: ['a', 'b'], error: 'raw' })).toBe('raw')
  })
})