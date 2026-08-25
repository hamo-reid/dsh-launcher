import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '../../shared/types.ts'
import { failFromError } from '../core/errors.ts'

/** Register an `ipcMain.handle` whose body runs without try/catch. Any thrown
 * error is normalized into a `failFromError` envelope, so handlers stay lean and
 * a missed catch can't leak an uncaught exception across the IPC boundary. */
export function handle<TArgs extends unknown[], T>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: TArgs) => IpcResult<T> | Promise<IpcResult<T>>,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcResult<T>> => {
    try {
      return await (fn as (e: IpcMainInvokeEvent, ...a: unknown[]) => IpcResult<T> | Promise<IpcResult<T>>)(
        event, ...args,
      )
    } catch (error) {
      return failFromError(error)
    }
  })
}