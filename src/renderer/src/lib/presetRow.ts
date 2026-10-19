/**
 * What one preset row offers, why a row may offer less, and how one preset's own
 * rows read when they are listed.
 *
 * The ROW decisions live here rather than in the row component, because both are
 * about ONE condition (`editable`, which the core sets) and its REASON:
 *
 * - Which actions the kebab menu has. `editable` is false for a preset the page
 *   may not write, and the two ways to get there are different stories.
 * - Which sentence explains that. A built-in preset ships with the deployment and
 *   is fixed by copying it; a home-layer declaration is the person's own, but
 *   every profile of the machine composes it, so the fix is to edit that patch.
 *   Showing the built-in wording for the home layer would name the wrong cause.
 *
 * The CONTENTS decisions live here for the same kind of reason: which section a
 * row belongs to (that grouping IS the classification a person reads), how a
 * grade reads, and what the page header's one-line summary of the whole roster
 * says. A second copy of any of them would let two surfaces disagree about the
 * same preset.
 *
 * They are pure functions because none of this renders in this repo's tests: the
 * kebab is an antd `Dropdown` (a portal, so its items are absent from a server
 * render) and the reason sits in a `Tooltip` (rendered on hover). See
 * `docs/TESTING.md` §4.
 */
import type {
  PresetCompositionRow, PresetGrade, PresetGradeLevel, PresetListItem, PresetRowState, PresetSource,
} from '../../../shared/types.ts'

/** A row action, as the i18n key suffix and the handler's key. */
export type PresetRowAction = 'edit' | 'copy' | 'delete'

/** The locale key naming where one definition comes from. Three surfaces need it
 * (the roster row, the sources panel, the contents view), and `as const` keeps the
 * values literal, which is what lets `t()` typecheck a looked-up key. */
export const PRESET_SOURCE_KEY = {
  package: 'preset.source.package',
  bundle: 'preset.source.bundle',
  profile: 'preset.source.profile',
  home: 'preset.source.home',
  'user-dir': 'preset.source.userDir',
} as const satisfies Record<PresetSource, string>

/** The i18n key explaining why a row offers no edit, or `undefined` when the
 * row IS editable. */
export function presetReadOnlyHintKey(
  preset: Pick<PresetListItem, 'editable' | 'source'>,
): 'preset.readOnlyHint' | 'preset.homeReadOnlyHint' | undefined {
  if (preset.editable) return undefined
  return preset.source === 'home' ? 'preset.homeReadOnlyHint' : 'preset.readOnlyHint'
}

/** The actions one row's menu offers. Copying is always available — a copy may
 * start from anything the profile can see, including a read-only source, and it
 * lands in the profile's own layer. */
export function presetRowActions(preset: Pick<PresetListItem, 'editable'>): PresetRowAction[] {
  return preset.editable ? ['edit', 'copy', 'delete'] : ['copy']
}

/**
 * The order a preset's rows are read in: what cannot work first.
 *
 * `missing` leads because it is the row the profile's grade is about — the one a
 * person can act on by installing something. A `!!js` gate follows: the launcher
 * cannot answer it at all, which is worth more attention than a row that is off
 * on purpose. `found` is last because a working row needs no attention.
 */
export const PRESET_ROW_SECTION_ORDER: readonly PresetRowState[] = ['missing', 'conditional', 'skipped', 'found']

/** One section of the contents view. */
export interface PresetRowSection {
  state: PresetRowState
  /** The rows in that state, in composition order. */
  rows: PresetCompositionRow[]
}

/** A preset's rows grouped by state, empty states left out, composition order kept
 * inside each section. One function, so a section and its count cannot disagree. */
export function presetRowSections(rows: readonly PresetCompositionRow[]): PresetRowSection[] {
  return PRESET_ROW_SECTION_ORDER
    .map(state => ({ state, rows: rows.filter(row => row.state === state) }))
    .filter(section => section.rows.length > 0)
}

/** A grade's label as an i18n key plus its params — the shape `LayerLabel`
 * established, so a looked-up key still typechecks and two surfaces cannot drift. */
export interface PresetGradeLabel {
  key: 'preset.grade.ok' | 'preset.grade.incomplete' | 'preset.grade.unusable' | 'preset.grade.unknown'
  options?: { count: number }
}

/** What a grade reads as. An `incomplete` grade leads with the count, which is the
 * whole reason the tag is worth looking at. */
export function presetGradeLabel(cell: PresetGrade | undefined): PresetGradeLabel {
  if (cell === undefined) return { key: 'preset.grade.unknown' }
  if (cell.level === 'ok') return { key: 'preset.grade.ok' }
  if (cell.level === 'unusable') return { key: 'preset.grade.unusable' }
  return { key: 'preset.grade.incomplete', options: { count: cell.missing.length } }
}

/** The Tag colour for a grade. */
export function presetGradeColour(cell: PresetGrade | undefined): string {
  if (cell === undefined) return 'default'
  return cell.level === 'ok' ? 'success' : cell.level === 'incomplete' ? 'warning' : 'error'
}

/** One segment of the page header's summary line: an i18n key plus its params, the
 * shape {@link PresetGradeLabel} established — so a looked-up key still typechecks
 * and the line cannot drift from the tags it summarises. The view joins them, and
 * chooses the separator: this function decides WHAT is said, not how it is spaced. */
export interface PresetRosterSegment {
  key:
    | 'preset.head.count'
    | 'preset.head.allOk'
    | 'preset.head.ok'
    | 'preset.head.unusable'
    | 'preset.head.incomplete'
    | 'preset.head.unknown'
  options?: { count: number }
}

/**
 * The one line the header says about a roster: how many presets there are, and how
 * they stand here.
 *
 * The cells arrive one per preset in roster order — the caller resolves them with
 * the same positional lookup the rows use, so the line cannot describe a roster
 * other than the one under it. Nothing to summarise is nothing to say: an empty
 * roster (or no listing yet) yields no segments and the header shows no line.
 *
 * `broken` is deliberately not a segment of its own. A declaration the host cannot
 * mount is exactly the `unusable` grade it was given (`rating.ts` grades an
 * unreadable composition unusable), so a second bucket would count one preset
 * twice in a line that is read as a total. The row still says 不能挂载 itself.
 *
 * A line of zeroes is noise, so `allOk` replaces the counts when there is nothing
 * to report — the one case with a single segment, and its meaning is unambiguous
 * beside the total. Problems keep severity order, so the worst reads first.
 */
export function presetRosterSummary(cells: readonly (PresetGrade | undefined)[]): PresetRosterSegment[] {
  if (cells.length === 0) return []
  const segments: PresetRosterSegment[] = [{ key: 'preset.head.count', options: { count: cells.length } }]
  const level = (one: PresetGradeLevel): number => cells.filter(cell => cell?.level === one).length
  const ok = level('ok')
  if (ok === cells.length) return [...segments, { key: 'preset.head.allOk' }]
  const named: [PresetRosterSegment['key'], number][] = [
    ['preset.head.ok', ok],
    ['preset.head.unusable', level('unusable')],
    ['preset.head.incomplete', level('incomplete')],
    // A roster is graded one cell per row, so a missing cell is a row the page
    // could not judge — worth saying rather than counting as fine.
    ['preset.head.unknown', cells.filter(cell => cell === undefined).length],
  ]
  for (const [key, count] of named) if (count > 0) segments.push({ key, options: { count } })
  return segments
}
