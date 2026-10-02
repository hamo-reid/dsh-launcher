/**
 * IPC argument validation. The path/version guards live in `core/profile/name-guard.ts`
 * (so core path builders share the exact same rules) and are re-exported here
 * for the IPC layer; `rowIdInvalid` is patch-document specific.
 */
import { listProfiles } from '../core/profile/home.ts'
import { fail, E } from '../core/shared/errors.ts'
import { pathIdentifierInvalid } from '../core/profile/name-guard.ts'
import type { DshContext } from '../core/profile/appState.ts'
import type { IpcResult } from '../../shared/types.ts'

export { pathIdentifierInvalid, pathOutsideRoot, versionInvalid } from '../core/profile/name-guard.ts'

/** True when `id` is not a safe row id for `- id: <value>` in a patch doc. Allows
 * a slug or an @scope/name but refuses anything that would break or extend that
 * line (spaces, colon, quote, newline, `#`/`{`/`[`, `$`, …). */
export function rowIdInvalid(id: string): boolean {
  return !/^[A-Za-z0-9@_./-]+$/.test(id)
}

/**
 * The profile an IPC-supplied profile name targets, validated: it becomes a PATH
 * and, in several tracks, it decides which layers compose — so an unknown name is
 * an error rather than a silently profile-less read that looks like "this
 * deployment contributes nothing".
 *
 * `null` means no profile was named (host layers only); an `IpcResult` is a
 * refusal the caller returns as-is.
 * @param ctx - the dsh whose profile list is authoritative.
 * @param raw - the untrusted value from the renderer.
 * @returns the profile name, `null`, or a failure to propagate.
 */
export function profileTarget(ctx: DshContext, raw: unknown): string | null | IpcResult<never> {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string' || pathIdentifierInvalid(raw)) return fail(E.nameInvalid)
  if (!listProfiles(ctx).includes(raw)) return fail(E.profileNotFound, { detail: raw })
  return raw
}

/** Whether {@link profileTarget} refused rather than picked. */
export function profileRefused(pick: string | null | IpcResult<never>): pick is IpcResult<never> {
  return pick !== null && typeof pick !== 'string'
}
