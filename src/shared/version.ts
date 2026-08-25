/**
 * Cross-process version helpers with no main-only dependencies, so both the
 * main process and the (sandboxed) renderer can import them without crossing
 * the process boundary. Backed by the pure `semver` package.
 */
import semver from 'semver'

/** Leading major component of a version (`2.0.0-beta` → 2), or `-1` unparseable. */
export function majorOfVersion(v: string): number {
  try {
    return semver.major(v.trim())
  } catch {
    return -1
  }
}