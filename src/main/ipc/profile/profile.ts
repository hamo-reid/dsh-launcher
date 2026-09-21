/**
 * Profile IPC (public facade). The 34 channels used to be one 520-line registrar;
 * they are now five grouped by what they act on, and this file keeps the
 * established `./profile.ts` entry point working unchanged.
 */
import { registerProfileEditIpc } from './edit.ts'
import { registerProfileLifecycleIpc } from './lifecycle.ts'
import { registerProfileReadIpc } from './read.ts'
import { registerProfileRowsIpc } from './rows.ts'
import { registerProfileTransferIpc } from './transfer.ts'

export function registerProfileIpc(): void {
  registerProfileReadIpc()
  registerProfileLifecycleIpc()
  registerProfileEditIpc()
  registerProfileRowsIpc()
  registerProfileTransferIpc()
}
