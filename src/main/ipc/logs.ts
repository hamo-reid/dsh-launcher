/** IPC for the log system (`logs:*`) — reveal the log directory in the OS
 * file explorer. */

import { ipcMain, shell } from 'electron'
import { logsDirectory } from '../core/logger.ts'
import type { IpcResult } from '../../shared/types.ts'

export function registerLogsIpc(): void {
  ipcMain.handle('logs:reveal', async (): Promise<IpcResult<boolean>> => {
    try {
      const dir = logsDirectory()
      if (dir === '') return { ok: false, code: 'logs.notInitialized', error: 'logs dir not initialized' }
      const error = await shell.openPath(dir)
      return error === '' ? { ok: true, value: true } : { ok: false, code: 'shell.openPath', params: { detail: error }, error }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 'internal', params: { detail }, error: detail }
    }
  })
}