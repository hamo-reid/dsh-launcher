/**
 * Identifier / identifier-ish argument validation for IPC handlers. These guard
 * the path- and command-building primitives (store dirs, profile dirs, pnpm
 * specs) so a compromised renderer can't escape the store/profile trees with a
 * `../`/`\`/absolute-path/command-injection name. An npm scoped name
 * (`@scope/name`) is the one legitimate `/`.
 */

/** True when `v` is not a safe path-identifier token. Refuses `..`, `\`, a
 * leading/trailing/doubled `/`, a drive-letter prefix, or shell metacharacters. */
export function pathIdentifierInvalid(v: string): boolean {
  if (v === '') return true
  if (v.includes('\\') || v.includes('..')) return true
  if (v.startsWith('/') || v.endsWith('/') || v.includes('//')) return true
  if (/^[A-Za-z]:/.test(v)) return true
  if (/[`$;|&<>]/.test(v)) return true
  return false
}

/** True when `v` is not a plain semver-ish version token (`2.1.0-beta.1`). */
export function versionInvalid(v: string): boolean {
  return !/^[0-9A-Za-z.+-]+$/.test(v)
}

/** True when `id` is not a safe row id for `- id: <value>` in a patch doc. mows a
 * slug or an @scope/name but refuses anything that would break or extend that
 * line (spaces, colon, quote, newline, `#`/`{`/`[`, `$`, …). */
export function rowIdInvalid(id: string): boolean {
  return !/^[A-Za-z0-9@_./-]+$/.test(id)
}