/**
 * Plugin IPC (public facade). The 39 channels used to be one 590-line registrar;
 * they are now four registrars grouped by what they act on, and this file keeps
 * the established `./plugins.ts` entry point working unchanged.
 *
 * `ensurePluginStore` is re-exported because the data-root IPC validates the
 * store location it derives; it lives with the rest of the store.
 */
import { registerDevIpc } from './dev.ts'
import { registerDownloadsIpc } from './downloads.ts'
import { registerStoreIpc } from './store.ts'
import { registerUpdatesIpc } from './updates.ts'

export { ensurePluginStore } from './store.ts'

export function registerPluginsIpc(): void {
  registerStoreIpc()
  registerUpdatesIpc()
  registerDevIpc()
  registerDownloadsIpc()
}
