/**
 * The presets surface: one dsh's agent presets, the grade each one gets under
 * every profile, and the launcher's write half — display metadata, a copy, and
 * a move to the recycle bin.
 *
 * Reading a preset's composition or editing it is deliberately absent: the
 * composition is the preset, the launcher only reports on it, and the editor of
 * one's choice opens the directory for the rest.
 */

import { shell } from 'electron'
import { ctxOf } from '../ctxOf.ts'
import { handle } from '../handle.ts'
import { listProfiles } from '../../core/profile/home.ts'
import { copyPreset, deletePreset, savePresetMeta } from '../../core/presets/authoring.ts'
import { gradePresets } from '../../core/presets/rating.ts'
import { discoverPresets, presetById, presetRoots } from '../../core/presets/roots.ts'
import { E, fail, failFromError } from '../../core/shared/errors.ts'
import { PRESET_ID_RE } from '../../../shared/preset.ts'
import type { IpcResult, PresetListing, PresetMetaInput, PresetRow } from '../../../shared/types.ts'

/** Whether an id is unusable as a preset directory name. The id becomes a path
 * segment, so this is checked before any filesystem work, not by the core. */
function badId(id: unknown): boolean {
  return typeof id !== 'string' || !PRESET_ID_RE.test(id)
}

/** Whether a metadata payload has the wrong shape. Only the types are checked
 * here — the form's own values — and the trimming is the core's. */
function badMeta(meta: PresetMetaInput): boolean {
  if (typeof meta !== 'object' || meta === null) return true
  if (typeof meta.name !== 'string' || typeof meta.description !== 'string') return true
  return meta.order !== null && (typeof meta.order !== 'number' || !Number.isFinite(meta.order))
}

/** One roster row, or undefined when this dsh has no such preset. */
function rowOf(ctx: NonNullable<ReturnType<typeof ctxOf>>, id: string): PresetRow | undefined {
  return presetById(discoverPresets(presetRoots(ctx)), id)
}

export function registerPresetsIpc(): void {
  // Everything the page renders, in one read: the roots, the roster, the
  // profiles it grades against, and one grade per preset/profile pairing.
  handle('preset:list', (_event, dshId: string): IpcResult<PresetListing> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    try {
      const roots = presetRoots(ctx)
      const presets = discoverPresets(roots)
      const profiles = listProfiles(ctx)
      return { ok: true, value: { roots, presets, profiles, grades: gradePresets(ctx, presets, profiles) } }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Store the editable half of a locally authored preset. A built-in preset is
  // refused in the core, which is where its trust is known.
  handle('preset:saveMeta', (_event, dshId: string, id: string, meta: PresetMetaInput): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (badId(id)) return fail(E.presetBadId, { preset: id })
    if (badMeta(meta)) return fail(E.nameInvalid)
    try {
      savePresetMeta(ctx, id, meta)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Create a preset by copying an existing one into the writable root.
  handle('preset:copy', (_event, dshId: string, fromId: string, toId: string, name?: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (badId(fromId)) return fail(E.presetBadId, { preset: fromId })
    if (badId(toId)) return fail(E.presetBadId, { preset: toId })
    if (name !== undefined && typeof name !== 'string') return fail(E.nameInvalid)
    try {
      copyPreset(ctx, fromId, toId, name)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Move a locally authored preset to the OS recycle bin (reversible there).
  handle('preset:delete', async (_event, dshId: string, id: string): Promise<IpcResult<boolean>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (badId(id)) return fail(E.presetBadId, { preset: id })
    try {
      await deletePreset(ctx, id)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Reveal one preset's directory in the OS file manager.
  handle('preset:reveal', async (_event, dshId: string, id: string): Promise<IpcResult<boolean>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (badId(id)) return fail(E.presetBadId, { preset: id })
    const preset = rowOf(ctx, id)
    if (preset === undefined) return fail(E.presetNotFound, { preset: id })
    const error = await shell.openPath(preset.dir)
    return error === '' ? { ok: true, value: true } : fail(E.shellOpenPath, { detail: error })
  })

  // Open one preset's directory in VS Code, through the protocol the editor
  // registers: spawning `code` would depend on a PATH entry, and the protocol
  // is the editor's own contract for "open this folder".
  handle('preset:openEditor', async (_event, dshId: string, id: string): Promise<IpcResult<boolean>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (badId(id)) return fail(E.presetBadId, { preset: id })
    const preset = rowOf(ctx, id)
    if (preset === undefined) return fail(E.presetNotFound, { preset: id })
    // A protocol URL takes forward slashes on every platform, a Windows drive
    // letter included.
    const url = `vscode://file/${preset.dir.replace(/\\/g, '/')}`
    try {
      await shell.openExternal(url)
      return { ok: true, value: true }
    } catch (error) {
      return fail(E.shellOpenPath, { detail: error instanceof Error ? error.message : String(error) })
    }
  })
}
