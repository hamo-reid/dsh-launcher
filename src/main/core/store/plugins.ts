/**
 * Plugin store (public facade). The implementation now lives in focused modules
 * under this same directory; this barrel keeps the established
 * `../core/store/plugins.ts` import path (ipc/, profile.ts, tests, pluginDownloads)
 * working unchanged.
 */
export type { DshScope } from '../profile/appState.ts'

export { initStore, installedStoreVersion, latestStoreVersion, pluginVersionDir, storeVersions } from './layout.ts'
export { needsStoreMigration, migrateStore } from './migration.ts'
// `detachProfiles` and `retireTree` stay inside this directory: the first is how
// `removeArchivedVersion` names a selective detach for its own call site, the
// second is the step `removePlugin` builds on. Neither is a facade entry point.
export {
  deleteTreePhysical, profilesPointingAt, removeArchivedVersion, removePlugin, removePluginFromProfiles,
  sweepStoreTrash,
} from './uninstall.ts'
export { pluginsUsing } from './usage.ts'
export {
  addLocalPlugin, addPlugin, installIntoProfile, installSource, packageNameFromSource, repairArchiveLinks,
} from './install.ts'
export { buildInstalledOverview, findInstalledDir, listPlugins, listProfileScopes, readPluginReadme } from './overview.ts'