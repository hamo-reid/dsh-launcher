/**
 * Writing a preset of one's own: its display metadata, a copy of another, and
 * its removal.
 *
 * Authoring is confined to the writable root — the built-in set belongs to the
 * deployment, and letting the launcher rewrite it would turn "reset to a known
 * preset" into something the same tool could have broken first. Copying is the
 * whole-directory operation the host's own authoring offers, and it is the only
 * way to start from a built-in preset: the copy lands under the user root with
 * its composition intact, ready to be edited in the editor of one's choice.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { PRESET_ID_RE } from '../../../shared/preset.ts'
import { E, throwE } from '../shared/errors.ts'
import { writePresetMetadata } from './metadata.ts'
import { discoverPresets, presetById, presetRoots } from './roots.ts'
import type { DshContext } from '../profile/appState.ts'
import type { PresetMetaInput, PresetRow } from '../../../shared/types.ts'

/** The root locally authored presets are written to.
 * @param roots - the dsh's roots, in precedence order.
 * @returns the absolute path of the first writable root.
 * @throws when this deployment has no writable preset root.
 */
function writableRoot(roots: readonly { path: string; writable: boolean }[]): string {
  const root = roots.find(candidate => candidate.writable)
  if (root === undefined) throwE(E.presetNoUserRoot)
  return resolve(root.path)
}

/** One preset the launcher may change, resolved from disk.
 * @param ctx - the dsh to read.
 * @param id - the preset id.
 * @returns the roster row, which `editable` has proven writable.
 * @throws when no root supplies that id, or it ships with the deployment.
 */
function editablePreset(ctx: DshContext, id: string): PresetRow {
  const preset = presetById(discoverPresets(presetRoots(ctx)), id)
  if (preset === undefined) throwE(E.presetNotFound, { preset: id })
  if (!preset.editable) throwE(E.presetReadOnly, { preset: id })
  return preset
}

/**
 * Store one preset's display metadata (`preset.yml`).
 * @param ctx - the dsh whose roster is written.
 * @param id - the preset id.
 * @param meta - name, description and priority; empty values clear the key.
 * @throws `preset.notFound`, or `preset.readOnly` for a built-in preset.
 */
export function savePresetMeta(ctx: DshContext, id: string, meta: PresetMetaInput): void {
  writePresetMetadata(editablePreset(ctx, id).dir, meta)
}

/**
 * Create a preset by copying an existing one whole.
 *
 * The copy carries everything the source directory holds — composition,
 * metadata, skill directories, assets — because a preset is its directory, not
 * one file. Its metadata is then rewritten: the source's description is kept,
 * its name and roster priority are not, since a copy that presented itself
 * identically to its source would make the two indistinguishable in a list.
 * @param ctx - the dsh whose roster is written.
 * @param fromId - the preset the copy starts from; any trust is allowed.
 * @param toId - the new preset's id, which becomes its directory name.
 * @param name - display name for the copy; absent publishes none.
 * @throws `preset.notFound`, `preset.badId`, `preset.exists`, or
 * `preset.noUserRoot`.
 */
export function copyPreset(ctx: DshContext, fromId: string, toId: string, name?: string): void {
  const roots = presetRoots(ctx)
  const source = presetById(discoverPresets(roots), fromId)
  if (source === undefined) throwE(E.presetNotFound, { preset: fromId })
  if (!PRESET_ID_RE.test(toId)) throwE(E.presetBadId, { preset: toId })
  const rootDir = writableRoot(roots)
  const dest = join(rootDir, toId)
  // The roster check covers ids a built-in root shadows; this one covers a
  // directory that holds no composition and therefore never reached the roster.
  if (presetById(discoverPresets(roots), toId) !== undefined || existsSync(dest)) {
    throwE(E.presetExists, { preset: toId })
  }
  mkdirSync(rootDir, { recursive: true })
  try {
    cpSync(source.dir, dest, { recursive: true, dereference: true, force: false, errorOnExist: true })
    writePresetMetadata(dest, { name: name ?? '', description: source.description ?? '', order: null })
  } catch (error) {
    // A half-copied directory would be invisible to discovery at best and a
    // mountable-but-incomplete preset at worst, so a failed copy leaves nothing.
    if (dest.startsWith(rootDir + sep)) rmSync(dest, { recursive: true, force: true })
    throw error
  }
}

/** The injected OS-recycle-bin move; main wires `shell.trashItem`, tests a fake. */
let trash: ((target: string) => Promise<void>) | null = null

/** Inject the recycle-bin mover (main process wires shell.trashItem). */
export function setPresetTrash(next: ((target: string) => Promise<void>) | null): void {
  trash = next
}

/**
 * Move one locally authored preset to the OS recycle bin.
 *
 * The entry is resolved here, so the caller can never trash a path outside the
 * writable root, and a built-in preset is refused before any filesystem work.
 * @param ctx - the dsh whose preset is removed.
 * @param id - the preset id.
 * @throws `preset.notFound`, `preset.readOnly`, or when no mover is wired.
 */
export async function deletePreset(ctx: DshContext, id: string): Promise<void> {
  const preset = editablePreset(ctx, id)
  // Belt and braces over the roster: the resolved directory must still be the
  // one the writable root owns, whatever discovery reported.
  const rootDir = writableRoot(presetRoots(ctx))
  if (!resolve(preset.dir).startsWith(rootDir + sep)) throwE(E.presetReadOnly, { preset: id })
  if (trash === null) throw new Error('preset trash mover is not wired')
  await trash(preset.dir)
}
