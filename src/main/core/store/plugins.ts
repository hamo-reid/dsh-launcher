/**
 * Plugin store (public facade). The implementation now lives in focused modules
 * under this same directory; this barrel keeps the established
 * `../core/store/plugins.ts` import path (ipc/, profile.ts, tests, pluginDownloads)
 * working unchanged.
 */
export type { DshScope } from '../profile/appState.ts'

export { initStore, installedStoreVersion, latestStoreVersion, pluginVersionDir, storeVersions } from './layout.ts'
export { needsStoreMigration, migrateStore } from './migration.ts'
export { deleteTreePhysical, removePlugin, removePluginFromProfiles } from './uninstall.ts'
export {
  addLocalPlugin, addPlugin, installIntoProfile, installSource, packageNameFromSource, repairArchiveLinks,
} from './install.ts'
export { buildInstalledOverview, findInstalledDir, listPlugins, listProfileScopes, readPluginReadme } from './overview.ts'