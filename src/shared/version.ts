/**
 * Cross-process version helpers with no main-only dependencies, so both the
 * main process and the (sandboxed) renderer can import them without crossing
 * the process boundary. Backed by the pure `semver` package.
 */
import semver from 'semver'
import type { PackageVersionInfo } from './types.ts'

/** Leading major component of a version (`2.0.0-beta` → 2), or `-1` unparseable. */
export function majorOfVersion(v: string): number {
  try {
    return semver.major(v.trim())
  } catch {
    return -1
  }
}

/** Compare versions by their full semver semantics, including prerelease
 * handling (`2.0.0-beta.1` > `1.9.0`, but < `2.0.0`). Falls back to `0` when
 * either side is unparseable as a real version — a caller comparing against
 * junk gets "no opinion" rather than a wrong answer. */
export function compareVersionsLoose(a: string, b: string): number {
  try {
    return semver.compare(a.trim(), b.trim())
  } catch {
    return 0
  }
}

/**
 * The version a picker or an installer should treat as "the latest".
 *
 * `PackageVersionInfo.versions` is `Object.keys()` of the registry's version map,
 * so its order is the REGISTRY's, not semver's: npm hands them back in publish
 * order, oldest first. `versions[0]` is therefore the OLDEST release a package
 * ever published — measured on `left-pad`, it gave `0.0.3` while the registry's
 * own `dist-tags.latest` was `1.3.0`. Four call sites were reading index 0 as
 * "newest", one of which silently stopped offering updates at all.
 *
 * The registry answers the question outright, so `latest` wins whenever it names
 * a version the list actually carries (a preselected value that is not among the
 * options renders as a blank select). Without a usable tag the semver-HIGHEST is
 * the answer, not either end of the array: the order is the registry's own and a
 * mirror is not obliged to sort it.
 */
export function latestPackageVersion(info: PackageVersionInfo): string | undefined {
  const tagged = info.distTags?.latest
  if (typeof tagged === 'string' && tagged !== ''
    && (info.versions.length === 0 || info.versions.includes(tagged))) {
    return tagged
  }
  let best: string | undefined
  for (const version of info.versions) {
    if (best === undefined || compareVersionsLoose(version, best) > 0) best = version
  }
  return best
}
