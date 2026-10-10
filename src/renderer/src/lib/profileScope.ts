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

/**
 * One dsh's profile scope: the names it has, and the one its page shows.
 *
 * The names are TAGGED with the dsh they were read from, because a page switches
 * dsh in place — the same component keeps its state — while the names belong to
 * whichever dsh answered. Untagged, the previous dsh's name survives the switch
 * and the page asks the NEXT dsh about a profile it does not have: the IPC
 * boundary refuses that (`profile.notFound`), correctly, since a silently dropped
 * profile would read as "this dsh contributes nothing".
 */
export interface ProfileScope {
  /** The dsh these names were read from. */
  dshId: string
  /** That dsh's profile names, as `dsh.profiles` answered. */
  names: readonly string[]
  /** The name the page shows: always one of `names`, or `undefined`. */
  chosen: string | undefined
}

/** A scope built from a `dsh.profiles` answer: the remembered name while that dsh
 * still has it, the first profile otherwise, `undefined` when it has none.
 *
 * `remembered` is the one thing allowed across a dsh switch — a name, never a
 * claim that the other dsh has it (that claim is `names`, and it is re-read). */
export function profileScope(dshId: string, names: readonly string[], remembered?: string): ProfileScope {
  return { dshId, names, chosen: nextProfileChoice(remembered, names) }
}

/** The name a page may ask core about for `dshId`: only one THIS dsh's list
 * confirmed. A scope read from another dsh answers `undefined` — which is a real
 * answer (the machine-level view, or nothing to show), never a refusal. */
export function scopeProfile(scope: ProfileScope | null, dshId: string | undefined): string | undefined {
  return scope !== null && dshId !== undefined && scope.dshId === dshId ? scope.chosen : undefined
}

/** The names a page may offer for `dshId`: none until they are this dsh's, so a
 * control can never present — or let the user pick — another dsh's profile. */
export function scopeNames(scope: ProfileScope | null, dshId: string | undefined): readonly string[] {
  return scope !== null && dshId !== undefined && scope.dshId === dshId ? scope.names : []
}

/** Whether a page refused while asking about `refused` can ask again instead of
 * reporting: that name is not one the dsh has NOW (renamed, deleted, or the dsh's
 * home now points elsewhere), so re-reading the list changes the choice and the
 * next load asks about a confirmed one. A name still listed means the refusal is
 * real and the page says so.
 *
 * Shares {@link nextProfileChoice} with the fold that produced the choice, so the
 * decision and the reconciliation cannot drift. Call it only when a profile was
 * actually asked about: passed `undefined` it would read a fresh list as a reason
 * to leave the machine-level view and select the first profile. */
export function canReaskProfile(refused: string, names: readonly string[]): boolean {
  return nextProfileChoice(refused, names) !== refused
}
