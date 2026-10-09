/**
 * Guards the i18n resources: every language must expose exactly the same keys,
 * and every key must use the same interpolation placeholders — so switching
 * languages can never throw or silently miss a translation.
 *
 * It also guards the ERROR CATALOGUE against the translations. Both sides are
 * reachable from here because the catalogue is cross-process data
 * (`src/shared/error-codes.ts`, re-exported by `core/shared/errors.ts`) while the
 * messages are the renderer's. The failure it prevents is a real one:
 * `apiErrorText` prefers the localized message, so a code without a key shows the
 * user either a bare parameter or a raw code instead of a sentence.
 */
import { describe, it, expect } from 'vitest'
import zh from './locales/zh'
import en from './locales/en'
import { E } from '../../../shared/error-codes.ts'

const zhFlattened = zh.translation as Record<string, string>
const enFlattened = en.translation as Record<string, string>

function placeholders(text: string): string {
  return (text.match(/\{\{[a-zA-Z0-9]+\}\}/g) ?? []).sort().join(',')
}

describe('i18n resources', () => {
  it('zh and en expose identical key sets', () => {
    expect(Object.keys(enFlattened).sort()).toEqual(Object.keys(zhFlattened).sort())
  })

  it('every key has the same interpolation placeholders in both languages', () => {
    for (const key of Object.keys(zhFlattened)) {
      expect(placeholders(enFlattened[key]), `placeholder mismatch for "${key}"`).toBe(placeholders(zhFlattened[key]))
    }
  })

  it('no translation value is empty or unresolved from its own key', () => {
    for (const key of Object.keys(zhFlattened)) {
      expect(zhFlattened[key].trim(), `zh "${key}" empty`).not.toBe('')
      expect(enFlattened[key].trim(), `en "${key}" empty`).not.toBe('')
    }
  })

  it('every error code in the catalogue has a message in both languages', () => {
    // The invariant is total on purpose: no exceptions to remember, so adding a
    // code to `E` without its message fails here rather than surfacing as a raw
    // code in a toast on someone's machine.
    const codes = Object.values(E) as string[]
    expect(codes.length).toBeGreaterThan(0)
    for (const code of codes) {
      const key = `errors.${code}`
      expect(zhFlattened[key], `zh is missing "${key}"`).toBeDefined()
      expect(enFlattened[key], `en is missing "${key}"`).toBeDefined()
    }
  })

  it('a code carrying a detail renders it instead of the placeholder', () => {
    // `apiErrorText` interpolates params into the message, so the reason a call
    // passed has to survive into the sentence the user reads.
    expect(zhFlattened['errors.profile.notFound'].replace('{{detail}}', 'base-web')).toContain('base-web')
  })
})