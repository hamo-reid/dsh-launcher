/**
 * What one preset row offers, and why a row may offer less.
 *
 * Two decisions live here rather than in the row component, because both are
 * about ONE condition (`editable`, which the core sets) and its REASON:
 *
 * - Which actions the kebab menu has. `editable` is false for a preset the page
 *   may not write, and the two ways to get there are different stories.
 * - Which sentence explains that. A built-in preset ships with the deployment and
 *   is fixed by copying it; a home-layer declaration is the person's own, but
 *   every profile of the machine composes it, so the fix is to edit that patch.
 *   Showing the built-in wording for the home layer would name the wrong cause.
 *
 * They are pure functions because the row cannot be rendered in this repo's
 * tests: the kebab is an antd `Dropdown` (a portal, so its items are absent from
 * a server render) and the reason sits in a `Tooltip` (rendered on hover). See
 * `docs/TESTING.md` §4.
 */
import type { PresetListItem } from '../../../shared/types.ts'

/** A row action, as the i18n key suffix and the handler's key. */
export type PresetRowAction = 'edit' | 'copy' | 'delete'

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
