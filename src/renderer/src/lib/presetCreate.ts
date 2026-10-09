/**
 * Whether the "new preset" dialog may submit, and what is wrong with the draft.
 *
 * The "already taken" answer has to come from the SAME set of ids the core
 * refuses on, or the dialog offers a button that is certain to fail: the core
 * refuses an id a kept directory holds as well as one already on the roster, and
 * the roster does not show those directories. The set is passed in — built by the
 * page from the whole listing — so this file stays free of any read of its own.
 *
 * The core remains authoritative: this only decides what the dialog says before
 * anything is written.
 */
import { PRESET_ID_RE } from '../../../shared/preset.ts'

/** Why a draft cannot be submitted, or null when nothing is wrong with it. */
export type PresetCreateBlock = 'badId' | 'taken' | null

/**
 * Every id already in use here.
 *
 * Both halves matter: the roster, and the directories the retired root keeps.
 * Those directories are not on the roster any more (nothing reads them), but the
 * core refuses an id they hold — migrating one would declare the id twice — so a
 * dialog built from the roster alone offers a create that is certain to fail.
 * @param roster - the listing's presets.
 * @param legacy - the listing's kept directories.
 * @returns the ids the dialog treats as taken.
 */
export function presetTakenIds(
  roster: readonly { id: string }[],
  legacy: readonly { id: string }[],
): ReadonlySet<string> {
  return new Set([...roster.map(item => item.id), ...legacy.map(item => item.id)])
}

/** What the dialog needs to know about one draft. */
export interface PresetCreateDraft {
  toId: string
  /** Every id already in use here: the roster's and the kept directories'. */
  takenIds: ReadonlySet<string>
  /** The preset the new one starts from; empty means there is nothing to copy. */
  source: string
  busy: boolean
}

/** The blocker a draft has, in the order the dialog reports them. */
export function presetCreateBlock(
  draft: Pick<PresetCreateDraft, 'toId' | 'takenIds'>,
): PresetCreateBlock {
  if (draft.toId === '') return null
  if (!PRESET_ID_RE.test(draft.toId)) return 'badId'
  return draft.takenIds.has(draft.toId) ? 'taken' : null
}

/** Whether the draft can be submitted as it stands. */
export function presetCreateReady(draft: PresetCreateDraft): boolean {
  return draft.source !== '' && draft.toId !== '' && !draft.busy
    && presetCreateBlock(draft) === null
}
