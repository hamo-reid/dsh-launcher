/**
 * Plugin IPC (public facade). The 39 channels used to be one 590-line registrar;
 * they are now four registrars grouped by what they act on, and this file keeps
 * the established `./plugins.ts` entry point working unchanged.
 *
 * `setPluginStoreDir` is re-exported because the settings page and the onboarding
 * wizard both set the store location; it lives with the rest of the store.
 */
import { registerDevIpc } from './plugins-dev.ts'
import { registerDownloadsIpc } from './plugins-downloads.ts'
import { registerStoreIpc } from './plugins-store.ts'
import { registerUpdatesIpc } from './plugins-updates.ts'

export { setPluginStoreDir } from './plugins-store.ts'

export function registerPluginsIpc(): void {
  registerStoreIpc()
  registerUpdatesIpc()
  registerDevIpc()
  registerDownloadsIpc()
}
