/** Modals for the Plugins page. The implementation now lives in focused modules
 * under `./plugins/modals/`; this barrel keeps the established
 * `./PluginsModals.tsx` import path working for the views that consume them. */

export { PluginDetailModal } from './plugins/modals/PluginDetailModal.tsx'
export { InstallToProfileModal } from './plugins/modals/InstallToProfileModal.tsx'
export { DownloadVersionModal } from './plugins/modals/DownloadVersionModal.tsx'
export { BundleVersionModal } from './plugins/modals/BundleVersionModal.tsx'
export type { BundleVersionTarget } from './plugins/modals/BundleVersionModal.tsx'
export { UpdatePluginModal } from './plugins/modals/UpdatePluginModal.tsx'
export type { UpdatePluginTarget } from './plugins/modals/UpdatePluginModal.tsx'
export { PluginUpdatesModal } from './plugins/modals/PluginUpdatesModal.tsx'
