/**
 * Plugin store (public facade). The implementation now lives in focused modules
 * under this same directory; this barrel keeps the established
 * `../core/plugins.ts` import path (ipc/, profile.ts, tests, pluginDownloads)
 * working unchanged.
 */
export type { DshScope } from './appState.ts'

export { initStore, installedStoreVersion, latestStoreVersion, pluginVersionDir, storeVersions } from './store-layout.ts'
export { needsStoreMigration, migrateStore } from './store-migration.ts'
export { deleteTreePhysical, removePlugin, removePluginFromProfiles } from './store-uninstall.ts'
export {
  addLocalPlugin, addPlugin, installIntoProfile, installSource, packageNameFromSource, repairArchiveLinks,
} from './store-install.ts'
export { buildInstalledOverview, findInstalledDir, listPlugins, listProfileScopes, readPluginReadme } from './store-overview.ts'