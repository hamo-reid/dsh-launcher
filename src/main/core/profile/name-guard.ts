/**
 * Path-/identifier-safety primitives shared by the IPC boundary (untrusted
 * renderer-supplied names) and the core store/pnpm path builders. They keep an
 * id from escaping its tree via `..`/`\`/absolute/drive paths, and a version
 * from stepping out of its version dir. Pure — no Electron, no I/O.
 */
import { resolve, sep } from 'node:path'

/** True when `v` is not a safe path-identifier token. Refuses `..`, `\`, a
 * leading/trailing/doubled `/`, a drive-letter prefix, `:` (drive / NTFS ADS),
 * or shell metacharacters. An npm scoped name (`@scope/name`) is the one
 * legitimate `/`. */
export function pathIdentifierInvalid(v: string): boolean {
  if (v === '') return true
  if (v.includes('\\') || v.includes('..')) return true
  if (v.startsWith('/') || v.endsWith('/') || v.includes('//')) return true
  if (v.includes(':')) return true
  if (/[`$;|&<>]/.test(v)) return true
  return false
}

/** True when `v` is not a plain semver-ish version token (`2.1.0-beta.1`).
 * Refuses `.`/`..` explicitly: they pass the character class but, joined into a
 * path (`archive/<name>/..`), would step OUT of the version dir — a `remove`
 * with version `..` would delete the whole `archive/`. No real version is ever
 * made of only dots, so this rejects nothing legitimate. */
export function versionInvalid(v: string): boolean {
  if (v === '.' || v === '..' || v.includes('..')) return true
  return !/^[0-9A-Za-z.+-]+$/.test(v)
}

/** True when `target` resolves outside `root`. Exact equality counts as inside.
 * Used to confine destructive cleanup (e.g. temp-dir removal) to a known parent,
 * so a compromised renderer can't point it at an arbitrary directory. */
export function pathOutsideRoot(root: string, target: string): boolean {
  const r = resolve(root)
  const t = resolve(target)
  return t !== r && !t.startsWith(r + sep)
}
