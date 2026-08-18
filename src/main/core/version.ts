/**
 * Lightweight semver comparison — enough to decide whether a store-installed
 * plugin already satisfies a bundle's version constraint, without pulling in
 * the full `semver` dependency.
 */

export interface SemVer { major: number; minor: number; patch: number }

/** Parse a dotted numeric version (`1.2.3`). `null` for anything else
 * (including pre-release suffixes — those are conservatively unmatched). */
export function parseVersion(v: string): SemVer | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  if (m === null) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

function cmp(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/** Whether `version` satisfies `spec` under the common operators
 * (`^ ~ > >= < <= =` and exact / `*` / `x`). A missing component in the
 * constraint counts as 0. Conservative by design: an unparseable version or an
 * unsupported operator simply returns `false` (fall back to downloading). */
export function satisfiesRange(version: string, spec: string): boolean {
  const v = parseVersion(version)
  if (v === null) return false
  const s = spec.trim()
  if (s === '' || s === '*' || s === 'x' || s === 'latest') return true
  let op = '='
  let body = s
  for (const candidate of ['>=', '<=', '>', '<', '^', '~', '=']) {
    if (body.startsWith(candidate)) { op = candidate; body = body.slice(candidate.length).trim(); break }
  }
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(body)
  if (m === null) return false
  const want: SemVer = {
    major: Number(m[1]),
    minor: Number(m[2] ?? '0'),
    patch: Number(m[3] ?? '0'),
  }
  const c = cmp(v, want)
  switch (op) {
    case '>': return c > 0
    case '>=': return c >= 0
    case '<': return c < 0
    case '<=': return c <= 0
    case '^': return v.major === want.major && c >= 0
    case '~': return v.major === want.major && v.minor === want.minor && c >= 0
    default: return c === 0
  }
}