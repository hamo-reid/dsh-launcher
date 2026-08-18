/**
 * Guards the i18n resources: every language must expose exactly the same keys,
 * and every key must use the same interpolation placeholders — so switching
 * languages can never throw or silently miss a translation.
 */
import { describe, it, expect } from 'vitest'
import zh from './locales/zh'
import en from './locales/en'

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
})