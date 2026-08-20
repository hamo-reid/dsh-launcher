/**
 * Uniform IPC error codes. The main process returns `{ ok:false, code, params }`
 * instead of raw Chinese strings; the renderer maps `code` → localized text via
 * `t('errors.<code>')`, with `params` for interpolation. `error` is kept as the
 * raw original message as a fallback during migration and for detail display.
 */
import type { IpcResult } from '../../shared/types.ts'
import { logger } from './logger.ts'

export interface IpcFail extends Record<string, unknown> {
  code: string
  params?: Record<string, string> | string[]
  /** Raw original message (fallback detail until callers fully switch to t()). */
  error: string
}

type FailParams = Record<string, string> | string[]

/** An application error carrying a stable code + interpolation params. */
export class AppError extends Error {
  readonly code: string
  readonly params?: FailParams
  constructor(code: string, params?: FailParams, message?: string) {
    super(message ?? code)
    this.name = 'AppError'
    this.code = code
    this.params = params
  }
}

/** Throw a coded app error (caught and converted by `failFromError`). */
export function throwE(code: string, params?: FailParams, message?: string): never {
  throw new AppError(code, params, message)
}

/** Build a `{ ok:false, code, params, error }` envelope directly. */
export function fail(code: string, params?: FailParams, message?: string): IpcResult<never> {
  const text = message ?? (Array.isArray(params)
    ? params.join('、')
    : (typeof params?.detail === 'string' ? params.detail : code))
  return { ok: false, code, params, error: text }
}

/** Normalize any thrown error into the envelope: coded AppError keeps its code,
 * anything else becomes the generic `internal` code (raw message in `error` +
 * `detail` param). */
export function failFromError(error: unknown): IpcResult<never> {
  if (error instanceof AppError) {
    // Deliberate business error — record at warn so failures stay greppable
    // without spamming the daily file.
    logger.warn(`app error (${error.code})`, error)
    return { ok: false, code: error.code, params: error.params, error: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  // Unknown/unexpected exception — full log with stack (the envelope drops it).
  logger.error('internal error', error)
  return { ok: false, code: 'internal', params: { detail: message }, error: message }
}

/** Common error codes, for reference / reuse in throwE/fail. */
export const E = {
  internal: 'internal',
  needActiveDsh: 'dsh.needActive',
  dshNotFound: 'dsh.notFound',
  dshNotManaged: 'dsh.notManaged',
  dshUpToDate: 'dsh.upToDate',
  dshMajorRisk: 'dsh.majorRisk',
  nameInvalid: 'name.invalid',
  profileExists: 'profile.exists',
  profileNotFound: 'profile.notFound',
  storeNotConfigured: 'store.notConfigured',
  storeNotDir: 'store.notDir',
  trashConflict: 'trash.conflict',
  bundleNotFound: 'bundle.notFound',
  npmNotFound: 'npm.notFound',
  yamlInvalid: 'yaml.invalid',
} as const