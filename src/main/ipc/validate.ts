/**
 * IPC argument validation. The path/version guards live in `core/name-guard.ts`
 * (so core path builders share the exact same rules) and are re-exported here
 * for the IPC layer; `rowIdInvalid` is patch-document specific.
 */
export { pathIdentifierInvalid, pathOutsideRoot, versionInvalid } from '../core/name-guard.ts'

/** True when `id` is not a safe row id for `- id: <value>` in a patch doc. Allows
 * a slug or an @scope/name but refuses anything that would break or extend that
 * line (spaces, colon, quote, newline, `#`/`{`/`[`, `$`, …). */
export function rowIdInvalid(id: string): boolean {
  return !/^[A-Za-z0-9@_./-]+$/.test(id)
}
