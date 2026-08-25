/** Small helpers for talking to the preload `window.api` from the renderer. */

import i18n from 'i18next'
import type { IpcResult } from '../../../shared/types.ts'

type Params = Record<string, string> | string[]

/** Turn a failed `IpcResult` into localized text: map `code` → `errors.<code>`
 * with `params` for interpolation; fall back to the raw `error`/detail. */
export function apiErrorText(result: { ok: false; code: string; params?: Params; error: string }): string {
  const params = (typeof result.params === 'object' && !Array.isArray(result.params) ? result.params : {}) as Record<string, string>
  const text = i18n.t(`errors.${result.code}`, { ...params, defaultValue: '' })
  if (text !== '' && text !== `errors.${result.code}`) return text
  // Fallback to raw detail / message for codes we haven't localized yet.
  if (typeof params.detail === 'string' && params.detail !== '') return params.detail
  return result.error
}