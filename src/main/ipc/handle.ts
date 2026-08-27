import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '../../shared/types.ts'
import { failFromError } from '../core/errors.ts'
import { child } from '../core/logger.ts'

/** Domain-tagged audit logger for the IPC boundary (`{domain:"ipc"}`). */
const ipclog = child('ipc')

/** Whether every request invocation is logged (Debug). On with `DSH_IPC_AUDIT=1`
 * or any pinned sink at `debug` — the kind of high-frequency trace that should
 * be opt-in, not on by default. */
function ipcAuditInvoke(): boolean {
  if (process.env.DSH_IPC_AUDIT === '1') return true
  return [process.env.DSH_LOG_CONSOLE_LEVEL, process.env.DSH_LOG_LEVEL, process.env.DSH_LOG_FILE_LEVEL]
    .some(level => level === 'debug')
}

/** Collapse an argument for audit — truncate long strings (paths, urls) but keep
 * structure and types, so a wrongly-large or nested payload stays greppable
 * without spamming the archive with hundreds of bytes per call. */
function auditArg(a: unknown): unknown {
  if (typeof a === 'string') return a.length > 120 ? `${a.slice(0, 120)}…(+${a.length - 120})` : a
  if (Array.isArray(a)) return a.map(auditArg)
  if (a !== null && typeof a === 'object') {
    return Object.fromEntries(
      Object.entries(a as Record<string, unknown>).map(([k, v]) => [k, auditArg(v)]),
    )
  }
  return a
}

/** Register an `ipcMain.handle` whose body runs without try/catch. Any thrown
 * error is normalized into a `failFromError` envelope — so handlers stay lean and
 * a missed catch can't leak an uncaught exception across the IPC boundary. The
 * wrapper also audits the boundary: every invocation (when `DSH_IPC_AUDIT` /
 * debug is on) and every non-ok return is logged under the `ipc` domain, making
 * the IPC layer fully traceable without scattering `logger` calls in handlers. */
export function handle<TArgs extends unknown[], T>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: TArgs) => IpcResult<T> | Promise<IpcResult<T>>,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcResult<T>> => {
    if (ipcAuditInvoke()) ipclog.debug(`ipc invoke: ${channel}`, { args: args.map(auditArg) })
    try {
      const result = await (fn as (e: IpcMainInvokeEvent, ...a: unknown[]) => IpcResult<T> | Promise<IpcResult<T>>)(
        event, ...args,
      )
      // A deliberate business failure returned without a throw — record at debug
      // so failures are auditable without warning-spamming everyday denials.
      if (result !== undefined && result !== null && !result.ok) {
        ipclog.debug(`ipc fail: ${channel}`, { code: result.code })
      }
      return result
    } catch (error) {
      ipclog.debug(`ipc threw: ${channel}`)
      return failFromError(error)
    }
  })
}