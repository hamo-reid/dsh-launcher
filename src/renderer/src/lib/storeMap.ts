/**
 * The plugin store's archived versions, indexed by package name.
 *
 * `plugins.list()` returns one entry per (name, version); every caller that wants
 * "which versions do I have of this?" needs the grouped form, and two views and a
 * modal all asked for it.
 */

/** Group `{name, version}` entries into name → versions, in the order given. */
export function toStoreMap(rows: { name: string; version: string }[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const row of rows) {
    const versions = map.get(row.name)
    if (versions === undefined) map.set(row.name, [row.version])
    else versions.push(row.version)
  }
  return map
}
