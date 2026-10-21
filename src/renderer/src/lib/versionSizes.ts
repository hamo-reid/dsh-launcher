/**
 * Per-version size arithmetic for the plugin detail modal.
 *
 * Two different numbers exist and they must not be confused:
 *
 *  - the plugin TOTAL (`plugins:calcSizes`), measured by walking every archived
 *    version with one shared inode map, so a file hard-linked into two versions is
 *    counted ONCE. It is the real cost of keeping the plugin.
 *  - a VERSION's size (`plugins:calcVersionSizes`), measured by walking that
 *    version alone. It answers "if I delete this one, roughly what goes away",
 *    but two versions sharing a file each report it, so the values can sum to
 *    more than the total.
 *
 * Nothing here adds version sizes up to claim a total, and nothing divides the
 * total among versions: either would be inventing a number. The only two derived
 * figures are labelled as what they are — the share of the total that is SHARED
 * between versions, and the count of versions with no measurement.
 */

/**
 * What the per-version popover should say, given a version's own size and the
 * plugin's deduplicated total.
 *
 * `shared` is the honest leftover: total minus this version's alone-walk — i.e.
 * bytes this version references that are already counted elsewhere (another
 * version, or a file the two hard-link). It is `undefined` when there is nothing
 * to say (no measurement, or the numbers do not imply anything).
 */
export interface VersionSizeReading {
  /** This version's own walk, when known. */
  bytes?: number
  /** Bytes of this version that are shared with something else, when derivable. */
  shared?: number
}

/** Derive the reading for one version. Pure. */
export function versionSizeReading(
  version: string,
  versionSizes: Record<string, number> | undefined,
  pluginTotal: number | undefined,
): VersionSizeReading {
  const bytes = versionSizes?.[version]
  if (bytes === undefined) return {}
  // A version alone can legitimately exceed the plugin total: the total dedupes
  // a file this version references that ANOTHER version also holds. Never report
  // a negative "shared" — just say nothing about sharing.
  if (pluginTotal === undefined || pluginTotal <= 0 || bytes >= pluginTotal) return { bytes }
  return { bytes, shared: pluginTotal - bytes }
}

/**
 * How many archived versions have no measured size. Used to explain a list where
 * only some rows carry a number, instead of silently showing a partial picture.
 */
export function versionsWithoutSize(
  versions: readonly string[],
  versionSizes: Record<string, number> | undefined,
): string[] {
  return versions.filter(v => versionSizes?.[v] === undefined)
}

/** The sum of a set of measured version sizes — for the modal's own footnote,
 * which must be labelled as "measured per version" (NOT the plugin total). */
export function sumVersionSizes(versions: readonly string[], versionSizes: Record<string, number> | undefined): number {
  let total = 0
  for (const v of versions) total += versionSizes?.[v] ?? 0
  return total
}
