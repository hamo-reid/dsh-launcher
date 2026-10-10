/**
 * How a skill's SOURCE reads, and what one scanned root wears.
 *
 * Three surfaces answer the same question — the dsh panel's cards, its scanned-root
 * rows, and the library card's install summary — so the words and colours live here
 * rather than being respelled per view: the same place must read the same way
 * wherever it appears.
 *
 * The one rule worth stating outright: A TAG IS ONE FACT. A preset-contributed root
 * used to wear two tags — the generic "from a preset" beside "from preset cordis" —
 * which said the same thing twice and made one root read as two. The owner IS the
 * source there, so it wears that single tag.
 *
 * Pure, because the row that shows it is not renderable in this repo's tests the way
 * a card is: see `docs/TESTING.md` §4 for what a server render can and cannot see.
 */
import { presetSkillRootOwner } from '../../../shared/skill.ts'
import type { SkillRootInfo, SkillSource } from '../../../shared/types.ts'

/** The i18n key of a source's label (`ext.skills.source.*`). */
export const SOURCE_LABEL_KEY = {
  'user-dsh': 'ext.skills.source.userDsh',
  'user-agents': 'ext.skills.source.userAgents',
  custom: 'ext.skills.source.custom',
  bundled: 'ext.skills.source.bundled',
  preset: 'ext.skills.source.preset',
} as const satisfies Record<SkillSource, string>

/** The Tag colour of a source, so a place is recognisable by colour alone. */
export const SOURCE_COLOUR = {
  'user-dsh': 'blue',
  'user-agents': 'purple',
  custom: 'orange',
  bundled: 'default',
  preset: 'cyan',
} as const satisfies Record<SkillSource, string>

/** The label key for one source. */
export function sourceLabelKey(source: SkillSource): (typeof SOURCE_LABEL_KEY)[SkillSource] {
  return SOURCE_LABEL_KEY[source]
}

/** One tag a scanned root wears, before translation. */
export interface RootTag {
  /** i18n key. */
  key: (typeof SOURCE_LABEL_KEY)[SkillSource] | 'ext.skills.rootFromPreset' | 'ext.skills.rootRuntime'
  /** Interpolation for the key — a preset root carries its owner. */
  params?: Record<string, string>
  colour: string
}

/** The tags one scanned root wears: one per fact, never two for one.
 * @param root - the root as the core reported it (`root` is the label a preset
 * carries, `preset:<owner>`; see `shared/skill.ts`).
 * @returns one tag for an ordinary root, plus the runtime tag when the root's path
 * is not a path; a preset root's single tag names the preset. */
export function skillRootTags(root: Pick<SkillRootInfo, 'source' | 'root' | 'runtime'>): RootTag[] {
  const owner = presetSkillRootOwner(root.root)
  if (root.source === 'preset' && owner !== '') {
    return [{ key: 'ext.skills.rootFromPreset', params: { owner }, colour: SOURCE_COLOUR.preset }]
  }
  const tags: RootTag[] = [{ key: SOURCE_LABEL_KEY[root.source], colour: SOURCE_COLOUR[root.source] }]
  // A runtime root's `path` is JavaScript source, not a path — the launcher cannot
  // resolve it, and this tag is the only thing on the row that says so.
  if (root.runtime === true) tags.push({ key: 'ext.skills.rootRuntime', colour: 'default' })
  return tags
}
