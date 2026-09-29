/**
 * The presets surface: one PROFILE's agent presets, the grade each one gets under
 * that profile, and the launcher's write half — display text, a copy, a removal,
 * a move to the recycle bin, and the migration of a directory the retired root
 * still holds.
 *
 * Reading a preset's plugin list or editing it is deliberately absent: the
 * plugin list IS the preset, the launcher only reports on it and offers to open
 * the file that carries it.
 *
 * The profile is part of every call, not a page-level notion: on a dsh that
 * declares presets, the roster lives in that profile's own patch layer.
 */

import { dirname } from 'node:path'
import { shell } from 'electron'
import { ctxOf } from '../ctxOf.ts'
import { handle } from '../handle.ts'
import { invalidName } from '../profile/helpers.ts'
import {
  copyPresetIn, deletePresetIn, migrateLegacyPreset, presetListing, presetLocationOf, savePresetMetaIn,
} from '../../core/presets/index.ts'
import { E, fail, failFromError } from '../../core/shared/errors.ts'
import { PRESET_ID_RE } from '../../../shared/preset.ts'
import type { IpcResult, PresetListing, PresetMetaInput } from '../../../shared/types.ts'

/** Whether an id is unusable as a preset id. On the directory model it becomes a
 * path segment and on the declaration model a row key, so this is checked before
 * any filesystem work, not by the core. */
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

/** The folder to show for one preset: its own directory on the directory model,
 * or the folder holding the patch file that declares it. */
function revealDir(path: string, kind: 'dir' | 'file'): string {
  return kind === 'file' ? dirname(path) : path
}

export function registerPresetsIpc(): void {
  // Everything the page renders, in one read: this profile's roster, its model,
  // the definition sources and one grade per preset.
  handle('preset:list', (_event, dshId: string, profile: string): IpcResult<PresetListing> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(profile)) return fail(E.nameInvalid)
    try {
      return { ok: true, value: presetListing(ctx, profile) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Store the editable half of a preset the launcher owns. A built-in preset is
  // refused in the core, which is where its layer is known.
  handle('preset:saveMeta', (_event, dshId: string, profile: string, id: string, meta: PresetMetaInput): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(profile)) return fail(E.nameInvalid)
    if (badId(id)) return fail(E.presetBadId, { preset: id })
    if (badMeta(meta)) return fail(E.nameInvalid)
    try {
      savePresetMetaIn(ctx, profile, id, meta)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Create a preset in this profile by copying an existing one.
  handle('preset:copy', (_event, dshId: string, profile: string, fromId: string, toId: string, name?: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(profile)) return fail(E.nameInvalid)
    if (badId(fromId)) return fail(E.presetBadId, { preset: fromId })
    if (badId(toId)) return fail(E.presetBadId, { preset: toId })
    if (name !== undefined && typeof name !== 'string') return fail(E.nameInvalid)
    try {
      copyPresetIn(ctx, profile, fromId, toId, name)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Remove a preset the launcher owns: the directory model moves its directory to
  // the OS recycle bin (reversible there), the declaration model drops its row
  // from the profile patch.
  handle('preset:delete', async (_event, dshId: string, profile: string, id: string): Promise<IpcResult<boolean>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(profile)) return fail(E.nameInvalid)
    if (badId(id)) return fail(E.presetBadId, { preset: id })
    try {
      await deletePresetIn(ctx, profile, id)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Turn one directory the retired root still holds into a declaration in this
  // profile's own patch layer. The directory is left where it is.
  handle('preset:migrate', (_event, dshId: string, profile: string, id: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(profile)) return fail(E.nameInvalid)
    if (badId(id)) return fail(E.presetBadId, { preset: id })
    try {
      migrateLegacyPreset(ctx, profile, id)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Reveal where one preset's definition lives, in the OS file manager.
  handle('preset:reveal', async (_event, dshId: string, profile: string, id: string): Promise<IpcResult<boolean>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(profile)) return fail(E.nameInvalid)
    if (badId(id)) return fail(E.presetBadId, { preset: id })
    try {
      const { path, kind } = presetLocationOf(ctx, profile, id)
      // A file is shown IN its folder: opening it would launch whatever editor is
      // associated with YAML, which is not what "show me where this lives" means.
      const error = await shell.openPath(revealDir(path, kind))
      return error === '' ? { ok: true, value: true } : fail(E.shellOpenPath, { detail: error })
    } catch (error) {
      return failFromError(error)
    }
  })

  // Open one preset's definition in VS Code, through the protocol the editor
  // registers: spawning `code` would depend on a PATH entry, and the protocol is
  // the editor's own contract for "open this file".
  handle('preset:openEditor', async (_event, dshId: string, profile: string, id: string): Promise<IpcResult<boolean>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(profile)) return fail(E.nameInvalid)
    if (badId(id)) return fail(E.presetBadId, { preset: id })
    try {
      const { path } = presetLocationOf(ctx, profile, id)
      // A protocol URL takes forward slashes on every platform, a Windows drive
      // letter included.
      await shell.openExternal(`vscode://file/${path.replace(/\\/g, '/')}`)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })
}
