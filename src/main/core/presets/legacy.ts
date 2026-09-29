/**
 * Legacy preset DIRECTORIES on a dsh that no longer reads them.
 *
 * dsh 0.2.0-rc.1 removed the directory preset without a compatibility path: the
 * skill that documents the new model says it outright — "Nothing reads that
 * directory any more" — and points at the migration by hand. A launcher that only
 * stopped showing the tab would leave a person's authored presets on disk,
 * invisible, with no signal that they had stopped applying.
 *
 * So the directories are still discovered — the same walk, the same id filter,
 * the same metadata reader as before — and each one is reported as NOT LOADED,
 * with the migration the host's own instructions describe: the id from the
 * directory name, the display text from `preset.yml`, and the plugin entry list
 * from `agent.cordis.yml` verbatim.
 *
 * Nothing here deletes anything. A migration writes a new declaration and leaves
 * the directory alone; removing it is a separate, deliberate step.
 */

import { existsSync, readFileSync } from 'node:fs'
import { discoverPresets, userPresetRoot } from './roots.ts'
import type { DeclarationInput } from './declaration.ts'
import type { DshContext } from '../profile/appState.ts'
import type { PresetRow, PresetRootInfo } from '../../../shared/types.ts'

/** The verdict on one legacy composition: its text, or why it cannot be migrated. */
type LegacyComposition = { ok: true; text: string } | { ok: false; problem: string }

/** One legacy directory dsh no longer reads. */
export interface LegacyPreset {
  /** The preset's id: the directory name, which becomes the declaration's id. */
  id: string
  /** The directory on disk. */
  dir: string
  name?: string
  description?: string
  order?: number
  /** The plugin entry list, or why it cannot be read. */
  read: LegacyComposition
  /** Absolute path of the composition file that makes the directory a preset. */
  compositionPath: string
}

/** Read one legacy directory's composition, reusing discovery's own verdict. */
function readLegacyComposition(row: PresetRow): LegacyComposition {
  if (row.broken !== undefined) return { ok: false, problem: row.broken }
  try {
    return { ok: true, text: readFileSync(row.compositionPath, 'utf8') }
  } catch {
    return { ok: false, problem: 'the composition file cannot be read' }
  }
}

/**
 * Every legacy preset directory under one dsh's home.
 *
 * Reported whatever the profile's model is: on a directory-model dsh these are
 * live presets the tab already lists, and the caller decides what to say. The
 * question this answers is "what is on disk under the retired root", not "what is
 * broken".
 * @param ctx - the dsh whose home is scanned.
 * @returns the directories, in the root's own priority order.
 */
export function legacyPresets(ctx: DshContext): LegacyPreset[] {
  const path = userPresetRoot(ctx)
  const root: PresetRootInfo = { path, trust: 'user', exists: existsSync(path), writable: true }
  return discoverPresets([root]).map(row => ({
    id: row.id,
    dir: row.dir,
    compositionPath: row.compositionPath,
    ...(row.name === undefined ? {} : { name: row.name }),
    ...(row.description === undefined ? {} : { description: row.description }),
    ...(row.order === undefined ? {} : { order: row.order }),
    read: readLegacyComposition(row),
  }))
}

/**
 * The declaration a legacy directory migrates to.
 *
 * `plugins` is the composition file's own text, re-indented one level: the list
 * is already a Cordis entry list, and copying it line for line is what makes the
 * migrated preset exactly as loadable as the directory was — comments, `!!js`
 * gates and block scalars included.
 * @param preset - a legacy directory whose composition reads.
 * @returns the input for {@link insertDeclaration}, or why it cannot migrate.
 */
export function migrationInput(preset: LegacyPreset): { ok: true; input: DeclarationInput } | { ok: false; problem: string } {
  if (!preset.read.ok) return { ok: false, problem: preset.read.problem }
  const indented = preset.read.text
    .split('\n')
    .map(line => (line.trim() === '' ? '' : `  ${line}`))
    .join('\n')
  return {
    ok: true,
    input: {
      id: preset.id,
      ...(preset.name === undefined ? {} : { name: preset.name }),
      ...(preset.description === undefined ? {} : { description: preset.description }),
      ...(preset.order === undefined ? {} : { order: preset.order }),
      pluginsBlock: `plugins:\n${indented}`.trimEnd(),
    },
  }
}
