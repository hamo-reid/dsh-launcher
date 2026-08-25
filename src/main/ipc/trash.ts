/** IPC for the profile trash (`trash:*`): list, restore, delete, empty. */

import { ipcMain } from 'electron'
import { deleteTrashItem, emptyTrash, listTrashItems, restoreTrashItem } from '../core/trash.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { pathIdentifierInvalid } from './validate.ts'
import type { IpcResult, TrashItem } from '../../shared/types.ts'

export function registerTrashIpc(): void {
  ipcMain.handle('trash:list', (): IpcResult<TrashItem[]> => {
    try {
      return { ok: true, value: listTrashItems() }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('trash:restore', (_event, name: string): IpcResult<boolean> => {
    try {
      // A path-identifer that could escape `<trashDir>` (../, \, absolute) must
      // never reach a join + rename under the trash root.
      if (pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      restoreTrashItem(name)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('trash:delete', (_event, name: string): IpcResult<boolean> => {
    try {
      if (pathIdentifierInvalid(name)) return fail(E.nameInvalid)
      deleteTrashItem(name)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('trash:empty', (): IpcResult<number> => {
    try {
      return { ok: true, value: emptyTrash() }
    } catch (error) {
      return failFromError(error)
    }
  })
}