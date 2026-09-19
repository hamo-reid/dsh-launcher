/** IPC for the machine-level home patch layer (`home:*`). */

import { handle } from './handle.ts'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homePatchPath } from '../core/home.ts'
import { contextForEntry, dshEntryById } from '../core/appState.ts'
import { setRowDisabled } from '../core/patch.ts'
import { verifyDisabledState } from '../core/app-util.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { rowIdInvalid } from './validate.ts'
import type { IpcResult } from '../../shared/types.ts'

export function registerHomeIpc(): void {
  // Machine-level, shared by every profile; composes after each profile patch.
  handle('home:setDisabled', (_event, dshId: string, id: string, disabled: boolean): IpcResult<boolean> => {
    try {
      const entry = dshEntryById(dshId)
      if (entry === undefined) return fail(E.dshNotFound)
      if (rowIdInvalid(id)) return fail(E.nameInvalid)
      const path = homePatchPath(contextForEntry(entry))
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