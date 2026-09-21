/** IPC for the machine-level home patch layer (`home:*`). */

import { handle } from '../handle.ts'
import { ctxOf } from '../ctxOf.ts'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homePatchPath, readHomePatch, writeHomePatch } from '../../core/profile/home.ts'
import { setRowDisabled } from '../../core/patch/patch.ts'
import { verifyDisabledState } from '../../core/shared/app-util.ts'
import { fail, failFromError, E } from '../../core/shared/errors.ts'
import { rowIdInvalid } from '../validate.ts'
import type { IpcResult } from '../../../shared/types.ts'

export function registerHomeIpc(): void {
  // Machine-level, shared by every profile; composes after each profile patch.
  handle('home:setDisabled', (_event, dshId: string, id: string, disabled: boolean): IpcResult<boolean> => {
    try {
      const ctx = ctxOf(dshId)
      if (ctx === null) return fail(E.dshNotFound)
      if (rowIdInvalid(id)) return fail(E.nameInvalid)
      const path = homePatchPath(ctx)
      const current = existsSync(path) ? readFileSync(path, 'utf8') : '[]'
      writeFileSync(path, setRowDisabled(current, id, disabled))
      const after = readFileSync(path, 'utf8')
      if (verifyDisabledState(after, id, disabled)) return { ok: true, value: true }
      return fail(E.patchWriteVerify, { id })
    } catch (error) {
      return failFromError(error)
    }
  })

  // The home patch layer's raw text (source mode).
  handle('home:readPatch', (_event, dshId: string): IpcResult<{ text: string; path: string }> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    return { ok: true, value: readHomePatch(ctx) }
  })

  handle('home:writePatch', (_event, dshId: string, text: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    writeHomePatch(ctx, text)
    return { ok: true, value: true }
  })
}