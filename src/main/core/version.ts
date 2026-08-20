/**
 * Version comparison & range checking, backed by the `semver` package instead of
 * a hand-rolled comparator. Keeps the small API surface the rest of the app
 * uses (`parseVersion`, `compareVersions`, `satisfiesRange`, …) — which are
 * conservative-by-design in places (an unparseable token never forces a wrong
 * choice) — while delegating the actual semantics to semver, notably its native
 * prerelease handling for the update `next` track.
 */
import semver from 'semver'

export interface SemVer { major: number; minor: number; patch: number }

/** Parse a dotted numeric version into its parts. `null` when unt parseable
 * (mirrors semver's strict three-part requirement, so `1.2` and junk → null). */
export function parseVersion(v: string): SemVer | null {
  const parsed = semver.parse(v.trim())
  if (parsed === null) return null
  return { major: parsed.major, minor: parsed.minor, patch: parsed.patch }
}

/** Compare two versions: -1 / 0 / 1. An unparseable version compares as less
 * than a parseable one (conservative); two unparseable ones compare equal. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === null && pb === null) return 0
  if (pa === null) return -1
  if (pb === null) return 1
  // Both parseable → safe to hand the original strings to semver.
  return semver.compare(a.trim(), b.trim())
}

/** Compare versions by their full semver semantics, including prerelease
 * handling (`2.0.0-beta.1` > `1.9.0`, but < `2.0.0`). Falls back to `0` when
 * either side is unparseable as a real version. */
export function compareVersionsLoose(a: string, b: string): number {
  try {
    return semver.compare(a.trim(), b.trim())
  } catch {
    return 0
  }
}

/** Leading major component of a version (`2.0.0-beta` → 2), or `-1` unparseable. */
export function majorOfVersion(v: string): number {
  try {
    return semver.major(v.trim())
  } catch {
    return -1
  }
}

/**
 * Whether `version` satisfies `spec` using semver's range semantics
 * (`^ ~ > >= < <= =`, ranges, `||`, `x`). Conservative by design: an unparseable
 * version or an unsupported spec simply returns `false` (callers fall back to a
 * fetch rather than wrongly reusing the store copy). Blank / `*` / `x` /
 * `latest` match anything.
 */
export function satisfiesRange(version: string, spec: string): boolean {
  const s = spec.trim()
  if (s === '' || s === '*' || s === 'x' || s === 'latest') return true
  try {
    return semver.satisfies(version.trim(), s)
  } catch {
    return false
  }
}