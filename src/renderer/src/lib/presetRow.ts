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
 * row belongs to (that grouping IS the classification a person reads) and how a
 * grade reads. A second copy of either would let the list and the contents view
 * disagree about the same preset.
 *
 * They are pure functions because none of this renders in this repo's tests: the
 * kebab is an antd `Dropdown` (a portal, so its items are absent from a server
 * render) and the reason sits in a `Tooltip` (rendered on hover). See
 * `docs/TESTING.md` §4.
 */
import type {
  PresetCompositionRow, PresetGrade, PresetListItem, PresetRowState, PresetSource,
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
