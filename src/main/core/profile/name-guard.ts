/**
 * Path-/identifier-safety primitives shared by the IPC boundary (untrusted
 * renderer-supplied names) and the core store/pnpm path builders. They keep an
 * id from escaping its tree via `..`/`\`/absolute/drive paths, and a version
 * from stepping out of its version dir. Pure — no Electron, no I/O.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** True when `v` is not a safe path-identifier token. Refuses `..`, `\`, a
 * leading/trailing/doubled `/`, a drive-letter prefix, `:` (drive / NTFS ADS),
 * shell metacharacters, and any all-dots token. An npm scoped name
 * (`@scope/name`) is the one legitimate `/`.
 *
 * The all-dots rule matters beyond `..`: `join('archive', '.', '1.0.0')` and
 * `join('archive', 'pkg', '..')` both name an EXISTING ancestor, so a token that
 * is nothing but dots turns a per-plugin path into the whole archive (or the
 * store) — and those paths are cleaned up recursively. No real id is all dots. */
export function pathIdentifierInvalid(v: string): boolean {
  if (v === '') return true
  if (/^\.+$/.test(v)) return true
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

/**
 * Whether `target` is `root` itself or a descendant of it, under the PLATFORM's
 * own path semantics.
 *
 * `path.relative` is the primitive rather than a string prefix, because the
 * question is about directories and not about text: on Windows `C:\Data` and
 * `c:\data\x` are the same place, and a prefix test says they are not, silently
 * turning "still referenced" into "nobody references it" and "inside the allowed
 * root" into "outside it". `relative` compares the way the platform does —
 * case-insensitively on win32, case-sensitively on POSIX (where two spellings
 * really are two directories) — and it cannot be fooled by a sibling whose name
 * merely starts the same way (`C:\Data` vs `C:\Database`).
 * @param root - the container directory.
 * @param target - the path to test; resolved first, like the prefix version did.
 * @returns true when `target` is `root` or inside it.
 */
export function pathWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  // `''` is the root itself; a leading `..` (as a whole segment) climbs out; an
  // absolute result means a different root entirely (another drive on Windows).
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** True when `target` resolves outside `root`. Exact equality counts as inside.
 * Used to confine destructive cleanup (e.g. temp-dir removal) to a known parent,
 * so a compromised renderer can't point it at an arbitrary directory.
 *
 * The negation of {@link pathWithin}, so this shares its platform semantics: a
 * differently-cased spelling of a path inside the root is inside it. */
export function pathOutsideRoot(root: string, target: string): boolean {
  return !pathWithin(root, target)
}
