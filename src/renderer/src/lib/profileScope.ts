/**
 * Which profile a page's listing is scoped to.
 *
 * The choice is VIEW state — it says nothing about how anything behaves, only
 * which slice of a dsh the user is looking at — so it lives in the page rather
 * than in settings. The RULE is shared, because two pages now ask the same
 * question (presets, and the skills panel whose preset-contributed roots only
 * exist inside a profile's composition) and must answer it the same way.
 *
 * `undefined` is a real answer, not a missing value: with no profile the listing
 * is the dsh's machine-level view. For skills that means preset roots are absent,
 * which the page has to state rather than quietly show fewer rows.
 */

/** The profile to show once a fresh profile list has arrived: the remembered one
 * while it still exists, the first one otherwise. */
export function nextProfileChoice(previous: string | undefined, names: readonly string[]): string | undefined {
  if (previous !== undefined && names.includes(previous)) return previous
  return names[0]
}
