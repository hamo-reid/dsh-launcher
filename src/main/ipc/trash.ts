/** IPC for the profile trash (`trash:*`): list, restore, delete, empty. Every
 * handler takes an explicit `dshId` — there is no global active dsh. */

import { ctxOf } from './ctxOf.ts'
import { handle } from './handle.ts'
import { baseTrashName, deleteTrashItem, emptyTrash, listTrashItems, restoreTrashItem, trashDir } from '../core/trash.ts'
import { clearLaunchConfig, readProfileId } from '../core/launch-config.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { pathIdentifierInvalid } from './validate.ts'
import { join } from 'node:path'
import type { IpcResult, TrashItem } from '../../shared/types.ts'

export function registerTrashIpc(): void {
  handle('trash:list', (_event, dshId: string): IpcResult<TrashItem[]> => {
    try {
      const ctx = ctxOf(dshId)
      if (ctx === null) return fail(E.dshNotFound)
      return { ok: true, value: listTrashItems(ctx) }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('trash:restore', (_event, dshId: string, name: string): IpcResult<boolean> => {
    try {
      const ctx = ctxOf(dshId)
      if (ctx === null) return fail(E.dshNotFound)
      // A path-identifer that could escape `<trashDir>` (../, \, absolute) must
      // never reach a join + rename under the trash root.
      if (pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      restoreTrashItem(ctx, name)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('trash:delete', (_event, dshId: string, name: string): IpcResult<boolean> => {
    try {
      const ctx = ctxOf(dshId)
      if (ctx === null) return fail(E.dshNotFound)
      if (pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      // Permanently destroying the profile also discards its saved launch config.
      const id = readProfileId(join(trashDir(ctx), name))
      deleteTrashItem(ctx, name)
      clearLaunchConfig(id, `${dshId}::${baseTrashName(name)}`)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('trash:empty', (_event, dshId: string): IpcResult<number> => {
    try {
      const ctx = ctxOf(dshId)
      if (ctx === null) return fail(E.dshNotFound)
      // Drop each trashed profile's saved launch config before emptying.
      for (const item of listTrashItems(ctx)) {
        clearLaunchConfig(readProfileId(join(trashDir(ctx), item.name)), `${dshId}::${baseTrashName(item.name)}`)
      }
      return { ok: true, value: emptyTrash(ctx) }
    } catch (error) {
      return failFromError(error)
    }
  })
}
