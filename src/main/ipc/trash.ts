/** IPC for the profile trash (`trash:*`): list, restore, delete, empty. Every
 * handler takes an explicit `dshId` — there is no global active dsh. */

import { handle } from './handle.ts'
import { deleteTrashItem, emptyTrash, listTrashItems, restoreTrashItem } from '../core/trash.ts'
import { contextForEntry, dshEntryById, type DshContext } from '../core/appState.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { pathIdentifierInvalid } from './validate.ts'
import type { IpcResult, TrashItem } from '../../shared/types.ts'

function ctxOf(dshId: unknown): DshContext | null {
  if (typeof dshId !== 'string') return null
  const entry = dshEntryById(dshId)
  return entry === undefined ? null : contextForEntry(entry)
}

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
      deleteTrashItem(ctx, name)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('trash:empty', (_event, dshId: string): IpcResult<number> => {
    try {
      const ctx = ctxOf(dshId)
      if (ctx === null) return fail(E.dshNotFound)
      return { ok: true, value: emptyTrash(ctx) }
    } catch (error) {
      return failFromError(error)
    }
  })
}
