/** IPC for the machine-level home patch layer (`home:*`). */

import { ipcMain } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homePatchPath } from '../core/home.ts'
import { setRowDisabled } from '../core/patch.ts'
import { verifyDisabledState } from '../core/app-util.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { rowIdInvalid } from './validate.ts'
import type { IpcResult } from '../../shared/types.ts'

export function registerHomeIpc(): void {
  // Machine-level, shared by every profile; composes after each profile patch.
  ipcMain.handle('home:setDisabled', (_event, id: string, disabled: boolean): IpcResult<boolean> => {
    try {
      if (rowIdInvalid(id)) return fail(E.nameInvalid)
      const path = homePatchPath()
      const current = existsSync(path) ? readFileSync(path, 'utf8') : '[]'
      writeFileSync(path, setRowDisabled(current, id, disabled))
      const after = readFileSync(path, 'utf8')
      if (verifyDisabledState(after, id, disabled)) return { ok: true, value: true }
      return fail(E.patchWriteVerify, { id })
    } catch (error) {
      return failFromError(error)
    }
  })
}