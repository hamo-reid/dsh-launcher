/** Editing the patch rows themselves: add, remove, copy from a bundle, and set a row's config body. */


import { app, shell } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { profilePatchPath } from '../../core/profile/home.ts'
import { appendRowBlock, extractRowBlock, removeRow, setRowConfig, upsertRow } from '../../core/patch/patch.ts'
import { resolveBundlePatch } from '../../core/store/combo.ts'
import { dedentRowBlock } from '../../core/shared/app-util.ts'
import { fail, E } from '../../core/shared/errors.ts'
import { ctxOf } from '../ctxOf.ts'
import { handle } from '../handle.ts'
import { assertConfigValid, assertInsertValid, invalidName, readUserPatch, writeUserPatch } from './helpers.ts'
import { rowIdInvalid } from '../validate.ts'
import type { IpcResult, RowCreateInput } from '../../../shared/types.ts'



/** Validate a config value is a YAML mapping. Structure only, so a cordis
 * `!!js` reference (which the schema cannot resolve) is not misread as bad
 * YAML. Throws with a friendly message. */

export function registerProfileRowsIpc(): void {
  // Create / update a row (pure id, disabled, config override, or insert) on the
  // profile's own patch layer. Content is YAML-validated before writing.
  handle('profile:addRow', (_event, dshId: string, name: string, row: RowCreateInput): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    const id = row.id.trim()
    if (rowIdInvalid(id)) return fail(E.nameInvalid)
    if (row.config !== undefined && row.config.trim() !== '') assertConfigValid(row.config)
    if (row.insert !== undefined && row.insert.length > 0) assertInsertValid(row.insert)
    writeUserPatch(ctx, name, upsertRow(readUserPatch(ctx, name), { ...row, id }))
    return { ok: true, value: true }
  })

  // Remove a row's override from the profile layer (restores the bundle default).
  handle('profile:removeRow', (_event, dshId: string, name: string, id: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    if (!existsSync(profilePatchPath(ctx, name))) return fail(E.patchNothingToRemove)
    writeUserPatch(ctx, name, removeRow(readUserPatch(ctx, name), id))
    return { ok: true, value: true }
  })

  // Copy a bundle row verbatim into the profile layer, so the user can then
  // override it there. The bundle package itself is never modified.
  handle('profile:copyRow', (_event, dshId: string, name: string, bundle: string, id: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name) || invalidName(bundle)) return fail(E.nameInvalid)
    const src = resolveBundlePatch(ctx, bundle, name)
    if (src === undefined) return fail(E.bundleNotFound, { bundle })
    const block = extractRowBlock(readFileSync(src, 'utf8'), id)
    if (block === undefined) return fail(E.bundleNoRow, { bundle, id })
    // The source row may sit nested under a group (extra leading indent);
    // re-base it to the top level so the copy stands as a valid top-level row.
    writeUserPatch(ctx, name, appendRowBlock(readUserPatch(ctx, name), dedentRowBlock(block)))
    return { ok: true, value: true }
  })

  // Edit an existing row's config block in the profile layer.
  handle('profile:setRowConfig', (_event, dshId: string, name: string, id: string, configText: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    writeUserPatch(ctx, name, setRowConfig(readUserPatch(ctx, name), id, configText))
    return { ok: true, value: true }
  })

  // Open the profile's `cordis.patch.yml` in the OS default editor, so the user
  // can hand-edit / repair it. Creates an empty overlay if it is missing.
  handle('profile:openPatchSource', async (_event, dshId: string, name: string): Promise<IpcResult<boolean>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    const path = profilePatchPath(ctx, name)
    if (!existsSync(path)) writeFileSync(path, '[]\n')
    const error = await shell.openPath(path)
    return error === '' ? { ok: true, value: true } : fail(E.shellOpenPath, { detail: error })
  })
}
