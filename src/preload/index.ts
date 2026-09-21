/** Preload: expose a type-safe, whitelisted `window.api` to the renderer.
 * The contract lives in `src/shared/api.ts`; this object is checked against it
 * so the implementation can never drift from what the renderer sees. */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ComboPlugin,
  DshDataImportResult,
  DshDataManifest,
  DshEntry,
  DshProfileInfo,
  DshUpdateInfo,
  DevBuildTarget,
  DevDiagnosis,
  DevLinkMode,
  DevPlugin,
  DevRunResult,
  DevScriptOptions,
  DownloadSessionInfo,
  GithubAuthState,
  GithubRateLimit,
  HealthIssue,
  ImportProfileResult,
  InstalledPlugin,
  ImportStep,
  InstalledOverviewRow,
  InsertConflict,
  IpcResult,
  AppUpdateInfo,
  PluginUsagePoint,
  MarketAnnotations,
  MarketListOpts,
  MarketPage,
  MarketPlugin,
  MarketSourceState,
  NodeEnvironment,
  NpmSearchHit,
  OnboardingPayload,
  OnboardingState,
  PackageVersionInfo,
  PluginRow,
  ProfileDetail,
  ProfileFileKind,
  ProfileLayer,
  ProfilePatchReload,
  ProfileSummary,
  ProfileValidation,
  RowCreateInput,
  PluginApplyResult,
  PluginCleanupResult,
  PluginMigrationResult,
  PluginUpdateInfo,
  PluginUpdateResult,
  RunEvent,
  RunDefaults,
  RunInfo,
  RunMode,
  LaunchOptions,
  McpListing,
  McpApplyTarget,
  McpLibOverviewRow,
  McpServer,
  McpServerInput,
  SkillEntry,
  SkillLibEntry,
  SkillLibIssue,
  SkillLibOverviewRow,
  SkillListing,
  TrashItem,
} from '../shared/types.ts'
import type { WindowApi } from '../shared/api.ts'

const api = {
  listProfiles: (dshId: string): Promise<IpcResult<string[]>> => ipcRenderer.invoke('profile:list', dshId),
  loadProfile: (dshId: string, name: string): Promise<IpcResult<ProfileDetail>> =>
    ipcRenderer.invoke('profile:load', dshId, name),
  setDisabled: (dshId: string, name: string, id: string, disabled: boolean): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:setDisabled', dshId, name, id, disabled),

  listProfileSummaries: (dshId: string): Promise<IpcResult<ProfileSummary[]>> => ipcRenderer.invoke('profile:summaries', dshId),
  createProfile: (dshId: string, name: string, template?: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:create', dshId, name, template),
  cloneProfile: (dshId: string, name: string, newName: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:clone', dshId, name, newName),
  deleteProfile: (dshId: string, name: string): Promise<IpcResult<boolean>> => ipcRenderer.invoke('profile:delete', dshId, name),
  exportProfile: (dshId: string, name: string): Promise<IpcResult<string>> => ipcRenderer.invoke('profile:export', dshId, name),
  exportToFile: (dshId: string, name: string, opts?: { zip?: boolean }): Promise<IpcResult<string>> =>
    ipcRenderer.invoke('profile:exportToFile', dshId, name, opts),
  localBundles: (dshId: string, name: string): Promise<IpcResult<string[]>> => ipcRenderer.invoke('profile:localBundles', dshId, name),
  importFromFile: (): Promise<IpcResult<{ json: string; name: string; dshVersion: string; unpackDir: string }>> =>
    ipcRenderer.invoke('profile:importFromFile'),
  importProfile: (dshId: string, json: string, name?: string, forceDsh?: boolean, localSource?: string): Promise<IpcResult<ImportProfileResult>> =>
    ipcRenderer.invoke('profile:import', dshId, json, name, forceDsh, localSource),
  mirrorProfile: (sourceDshId: string, targetDshId: string, profileName: string): Promise<IpcResult<ImportProfileResult>> =>
    ipcRenderer.invoke('profile:mirror', sourceDshId, targetDshId, profileName),
  onImportEvent: (callback: (step: ImportStep) => void): (() => void) => {
    const handler = (_: unknown, step: ImportStep): void => callback(step)
    ipcRenderer.on('import:event', handler)
    return () => { ipcRenderer.removeListener('import:event', handler) }
  },
  missingBundles: (dshId: string, name: string): Promise<IpcResult<string[]>> =>
    ipcRenderer.invoke('profile:missingBundles', dshId, name),
  layers: (dshId: string, name: string): Promise<IpcResult<ProfileLayer[]>> =>
    ipcRenderer.invoke('profile:layers', dshId, name),
  conflicts: (dshId: string, name: string): Promise<IpcResult<InsertConflict[]>> =>
    ipcRenderer.invoke('profile:conflicts', dshId, name),
  readFile: (dshId: string, name: string, kind: ProfileFileKind): Promise<IpcResult<{ text: string; path: string }>> =>
    ipcRenderer.invoke('profile:readFile', dshId, name, kind),
  writeFile: (dshId: string, name: string, kind: ProfileFileKind, text: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:writeFile', dshId, name, kind, text),
  validate: (dshId: string, name: string): Promise<IpcResult<ProfileValidation>> =>
    ipcRenderer.invoke('profile:validate', dshId, name),
  setDependency: (dshId: string, name: string, pkg: string, spec: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:setDependency', dshId, name, pkg, spec),
  removeDependency: (dshId: string, name: string, pkg: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:removeDependency', dshId, name, pkg),
  setManifest: (dshId: string, name: string, meta: { displayName?: string; patchReload?: ProfilePatchReload }): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:setManifest', dshId, name, meta),
  addBundle: (dshId: string, name: string, pkg: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:addBundle', dshId, name, pkg),
  rename: (dshId: string, oldName: string, newName: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:rename', dshId, oldName, newName),
  reveal: (dshId: string, name: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:reveal', dshId, name),
  transferPatch: (sourceDshId: string, sourceName: string, targetDshId: string, targetName: string, move: boolean): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:transferPatch', sourceDshId, sourceName, targetDshId, targetName, move),
  addRow: (dshId: string, name: string, row: RowCreateInput): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:addRow', dshId, name, row),
  setRowConfig: (dshId: string, name: string, id: string, configText: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:setRowConfig', dshId, name, id, configText),
  removeRow: (dshId: string, name: string, id: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:removeRow', dshId, name, id),
  copyRow: (dshId: string, name: string, bundle: string, id: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:copyRow', dshId, name, bundle, id),
  removeBundle: (dshId: string, name: string, bundle: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:removeBundle', dshId, name, bundle),
  reorderBundles: (dshId: string, name: string, bundle: string, toIndex: number): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:reorderBundle', dshId, name, bundle, toIndex),
  reconcileBundles: (dshId: string, name: string): Promise<IpcResult<{ added: string[]; removed: string[] }>> =>
    ipcRenderer.invoke('profile:reconcile', dshId, name),
  configInfo: (dshId: string, name: string, id: string): Promise<IpcResult<{ default: string; current: string }>> =>
    ipcRenderer.invoke('profile:configInfo', dshId, name, id),
  openPatchSource: (dshId: string, name: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:openPatchSource', dshId, name),

  home: {
    setDisabled: (dshId: string, id: string, disabled: boolean): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('home:setDisabled', dshId, id, disabled),
    readPatch: (dshId: string): Promise<IpcResult<{ text: string; path: string }>> =>
      ipcRenderer.invoke('home:readPatch', dshId),
    writePatch: (dshId: string, text: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('home:writePatch', dshId, text),
  },

  ext: {
    mcpList: (dshId: string, profile: string): Promise<IpcResult<McpListing>> =>
      ipcRenderer.invoke('ext:mcpList', dshId, profile),
    mcpHomeList: (dshId: string): Promise<IpcResult<McpServer[]>> =>
      ipcRenderer.invoke('ext:mcpHomeList', dshId),
    mcpSave: (dshId: string, profile: string, input: McpServerInput, layer: 'profile' | 'home'): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('ext:mcpSave', dshId, profile, input, layer),
    mcpRemove: (dshId: string, profile: string, id: string, layer: 'profile' | 'home'): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('ext:mcpRemove', dshId, profile, id, layer),
    mcpSetDisabled: (dshId: string, profile: string, id: string, disabled: boolean, layer: 'profile' | 'home'): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('ext:mcpSetDisabled', dshId, profile, id, disabled, layer),
    mcpSecrets: (): Promise<IpcResult<string[]>> =>
      ipcRenderer.invoke('ext:mcpSecrets'),
    mcpSecretSet: (name: string, value: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('ext:mcpSecretSet', name, value),
    mcpSecretRemove: (name: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('ext:mcpSecretRemove', name),
    skillList: (dshId: string): Promise<IpcResult<SkillListing>> =>
      ipcRenderer.invoke('ext:skillList', dshId),
    skillDelete: (dshId: string, name: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('ext:skillDelete', dshId, name),
    libMcpOverview: (): Promise<IpcResult<McpLibOverviewRow[]>> =>
      ipcRenderer.invoke('ext:libMcpOverview'),
    libMcpSave: (previousServerName: string | null, input: McpServerInput): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('ext:libMcpSave', previousServerName, input),
    libMcpRemove: (serverName: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('ext:libMcpRemove', serverName),
    libMcpApply: (serverName: string, target: McpApplyTarget): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('ext:libMcpApply', serverName, target),
    libMcpSync: (serverName: string): Promise<IpcResult<{ updated: number; skipped: number }>> =>
      ipcRenderer.invoke('ext:libMcpSync', serverName),
    libSkillList: (): Promise<IpcResult<{ skills: SkillLibEntry[]; issues: SkillLibIssue[] }>> =>
      ipcRenderer.invoke('ext:libSkillList'),
    libSkillOverview: (): Promise<IpcResult<SkillLibOverviewRow[]>> =>
      ipcRenderer.invoke('ext:libSkillOverview'),
    libSkillScaffold: (name: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('ext:libSkillScaffold', name),
    libSkillRead: (name: string): Promise<IpcResult<{ text: string; path: string }>> =>
      ipcRenderer.invoke('ext:libSkillRead', name),
    libSkillSave: (previousName: string | null, text: string): Promise<IpcResult<SkillLibEntry>> =>
      ipcRenderer.invoke('ext:libSkillSave', previousName, text),
    libSkillDelete: (name: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('ext:libSkillDelete', name),
    libSkillImportZip: (zipPath?: string): Promise<IpcResult<SkillLibEntry[] | null>> =>
      ipcRenderer.invoke('ext:libSkillImportZip', zipPath),
    libSkillInstall: (name: string, dshId: string, overwrite: boolean): Promise<IpcResult<SkillEntry>> =>
      ipcRenderer.invoke('ext:libSkillInstall', name, dshId, overwrite),
    filePath: (file: File): string => {
      // getPathForFile throws on a non-File; a File with no on-disk backing
      // yields ''. Never let either escape — the caller's input is untrusted.
      try { return webUtils.getPathForFile(file) } catch { return '' }
    },
  },

  run: {
    start: (profile: string, mode: RunMode | undefined, options: LaunchOptions | undefined, dshId: string): Promise<IpcResult<{ id: string }>> =>
      ipcRenderer.invoke('run:start', profile, mode, options, dshId),
    stop: (id: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('run:stop', id),
    list: (): Promise<IpcResult<RunInfo[]>> =>
      ipcRenderer.invoke('run:list'),
    logs: (id: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('run:logs', id),
    input: (id: string, line: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('run:input', id, line),
    getDefaults: (dshId: string, profile: string): Promise<IpcResult<RunDefaults>> =>
      ipcRenderer.invoke('run:getDefaults', dshId, profile),
    setDefaults: (dshId: string, profile: string, defaults: RunDefaults): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('run:setDefaults', dshId, profile, defaults),
    pickPatch: (): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('run:pickPatch'),
    openExternal: (url: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('openExternal', url),
    onEvent: (callback: (event: RunEvent) => void): (() => void) => {
      const handler = (_: unknown, event: RunEvent): void => callback(event)
      ipcRenderer.on('run:event', handler)
      return () => { ipcRenderer.removeListener('run:event', handler) }
    },
  },

  plugins: {
    getDir: (): Promise<IpcResult<{ dir: string }>> =>
      ipcRenderer.invoke('plugins:getDir'),
    setDir: (dir: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('plugins:setDir', dir),
    list: (): Promise<IpcResult<InstalledPlugin[]>> =>
      ipcRenderer.invoke('plugins:list'),
    add: (source: string, name?: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:add', source, name),
    addLocal: (kind: 'folder' | 'zip'): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:addLocal', kind),
    installToProfile: (dshId: string, profile: string, pkg: string, version?: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:installToProfile', dshId, profile, pkg, version),
    installOptions: (): Promise<IpcResult<{ id: string; name: string; version?: string; profiles: string[] }[]>> =>
      ipcRenderer.invoke('plugins:installOptions'),
    remove: (name: string, version?: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:remove', name, version),
    uninstall: (name: string): Promise<IpcResult<{ removed: PluginUsagePoint[] }>> =>
      ipcRenderer.invoke('plugins:uninstall', name),
    listCombo: (dshId: string, profile: string): Promise<IpcResult<ComboPlugin[]>> =>
      ipcRenderer.invoke('plugins:listCombo', dshId, profile),
    overview: (): Promise<IpcResult<InstalledOverviewRow[]>> =>
      ipcRenderer.invoke('plugins:overview'),
    calcSizes: (): Promise<IpcResult<Record<string, number>>> =>
      ipcRenderer.invoke('plugins:calcSizes'),
    checkUpdates: (opts?: { refresh?: boolean }): Promise<IpcResult<PluginUpdateInfo[]>> =>
      ipcRenderer.invoke('plugins:checkUpdates', opts),
    applyUpdates: (dshId: string, profile: string, updates: { name: string; version: string }[]): Promise<IpcResult<{ results: PluginApplyResult[] }>> =>
      ipcRenderer.invoke('plugins:applyUpdates', dshId, profile, updates),
    applyUpdate: (name: string, version: string, targets: { dshId: string; profile: string }[], opts?: { keepOld?: boolean }): Promise<IpcResult<PluginUpdateResult>> =>
      ipcRenderer.invoke('plugins:applyUpdate', name, version, targets, opts),
    cleanupVersions: (name: string): Promise<IpcResult<PluginCleanupResult>> =>
      ipcRenderer.invoke('plugins:cleanupVersions', name),
    migrateReplacement: (name: string, replacement: string): Promise<IpcResult<PluginMigrationResult>> =>
      ipcRenderer.invoke('plugins:migrateReplacement', name, replacement),
    reveal: (name: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('plugins:reveal', name),
    readme: (name: string): Promise<IpcResult<{ content: string; dir: string }>> =>
      ipcRenderer.invoke('plugins:readme', name),
    search: (query: string, opts?: { from?: number; size?: number }): Promise<IpcResult<{ hits: NpmSearchHit[]; total: number }>> =>
      ipcRenderer.invoke('plugins:search', query, opts),
    pkgVersions: (name: string): Promise<IpcResult<PackageVersionInfo>> =>
      ipcRenderer.invoke('plugins:pkgVersions', name),
    devList: (): Promise<IpcResult<{ plugins: DevPlugin[]; usage: Record<string, PluginUsagePoint[]> }>> =>
      ipcRenderer.invoke('plugins:devList'),
    devAdd: (): Promise<IpcResult<DevPlugin>> =>
      ipcRenderer.invoke('plugins:devAdd'),
    devRemove: (name: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('plugins:devRemove', name),
    devDiagnose: (name: string, dshId?: string): Promise<IpcResult<DevDiagnosis>> =>
      ipcRenderer.invoke('plugins:devDiagnose', name, dshId),
    devShimPeers: (name: string, dshId?: string): Promise<IpcResult<{ added: string[]; skipped: string[] }>> =>
      ipcRenderer.invoke('plugins:devShimPeers', name, dshId),
    devUnshimPeers: (name: string): Promise<IpcResult<{ removed: string[] }>> =>
      ipcRenderer.invoke('plugins:devUnshimPeers', name),
    devScripts: (name: string): Promise<IpcResult<{ options: DevScriptOptions; current?: DevBuildTarget }>> =>
      ipcRenderer.invoke('plugins:devScripts', name),
    devBuild: (name: string, target?: DevBuildTarget): Promise<IpcResult<DevRunResult>> =>
      ipcRenderer.invoke('plugins:devBuild', name, target),
    devInstall: (name: string): Promise<IpcResult<DevRunResult>> =>
      ipcRenderer.invoke('plugins:devInstall', name),
    devLinkToProfile: (dshId: string, profile: string, name: string, mode: DevLinkMode): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:devLinkToProfile', dshId, profile, name, mode),
    devRepairLink: (dshId: string, profile: string, name: string, opts?: { inSource?: boolean }): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:devRepairLink', dshId, profile, name, opts),
    devSnapshot: (name: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:devSnapshot', name),
    devReveal: (name: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('plugins:devReveal', name),
    devRevealWorkspace: (name: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('plugins:devRevealWorkspace', name),
  },

  downloads: {
    start: (source: string, name?: string): Promise<IpcResult<{ id: string }>> =>
      ipcRenderer.invoke('downloads:start', source, name),
    list: (): Promise<IpcResult<DownloadSessionInfo[]>> =>
      ipcRenderer.invoke('downloads:list'),
    cancel: (id: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('downloads:cancel', id),
    cleanup: (): Promise<IpcResult<{ removed: string[] }>> =>
      ipcRenderer.invoke('downloads:cleanup'),
    onChange: (fn: (list: DownloadSessionInfo[]) => void): (() => void) => {
      const listener = (_e: unknown, list: DownloadSessionInfo[]): void => fn(list)
      ipcRenderer.on('download:change', listener)
      return () => ipcRenderer.removeListener('download:change', listener)
    },
    onSettled: (fn: (session: DownloadSessionInfo) => void): (() => void) => {
      const listener = (_e: unknown, session: DownloadSessionInfo): void => fn(session)
      ipcRenderer.on('download:settled', listener)
      return () => ipcRenderer.removeListener('download:settled', listener)
    },
  },

  market: {
    list: (opts?: MarketListOpts): Promise<IpcResult<MarketPage>> =>
      ipcRenderer.invoke('market:list', opts),
    source: (): Promise<IpcResult<MarketSourceState>> => ipcRenderer.invoke('market:source'),
    setSource: (next: MarketSourceState): Promise<IpcResult<boolean>> => ipcRenderer.invoke('market:setSource', next),
    resolve: (url: string): Promise<IpcResult<{ spec: string | null; plugin: MarketPlugin | null }>> =>
      ipcRenderer.invoke('market:resolve', url),
    annotations: (): Promise<IpcResult<MarketAnnotations>> =>
      ipcRenderer.invoke('market:annotations'),
  },

  settings: {
    getUiLanguage: (): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke('settings:getUiLanguage'),
    setUiLanguage: (lng: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('settings:setUiLanguage', lng),
    getOnboardingState: (): Promise<IpcResult<OnboardingState>> =>
      ipcRenderer.invoke('settings:getOnboardingState'),
    pickDir: (opts?: { title?: string; defaultPath?: string }): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('settings:pickDir', opts),
    completeOnboarding: (payload: OnboardingPayload): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('settings:completeOnboarding', payload),
    checkHealth: (): Promise<IpcResult<HealthIssue[]>> =>
      ipcRenderer.invoke('settings:checkHealth'),
    getCloseToTray: (): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('settings:getCloseToTray'),
    setCloseToTray: (enabled: boolean): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('settings:setCloseToTray', enabled),
    getAskOnClose: (): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('settings:getAskOnClose'),
    setAskOnClose: (enabled: boolean): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('settings:setAskOnClose', enabled),
    getNodeEnvironment: (): Promise<IpcResult<NodeEnvironment>> =>
      ipcRenderer.invoke('settings:getNodeEnvironment'),
    setNodePreference: (preference: 'system' | 'bundled'): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('settings:setNodePreference', preference),
    getGithubAuth: (): Promise<IpcResult<GithubAuthState>> =>
      ipcRenderer.invoke('settings:getGithubAuth'),
    setGithubToken: (token: string): Promise<IpcResult<GithubAuthState>> =>
      ipcRenderer.invoke('settings:setGithubToken', token),
    testGithubToken: (): Promise<IpcResult<GithubRateLimit>> =>
      ipcRenderer.invoke('settings:testGithubToken'),
    exportSettings: (): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('settings:export'),
    importSettings: (): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('settings:import'),
  },

  trash: {
    list: (dshId: string): Promise<IpcResult<TrashItem[]>> =>
      ipcRenderer.invoke('trash:list', dshId),
    restore: (dshId: string, name: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('trash:restore', dshId, name),
    delete: (dshId: string, name: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('trash:delete', dshId, name),
    empty: (dshId: string): Promise<IpcResult<number>> =>
      ipcRenderer.invoke('trash:empty', dshId),
  },

  dsh: {
    list: (): Promise<IpcResult<{ dshes: DshEntry[] }>> =>
      ipcRenderer.invoke('dsh:list'),
    profiles: (id: string): Promise<IpcResult<DshProfileInfo[]>> =>
      ipcRenderer.invoke('dsh:profiles', id),
    add: (path: string): Promise<IpcResult<DshEntry>> =>
      ipcRenderer.invoke('dsh:add', path),
    remove: (id: string, opts?: { deleteFiles?: boolean }): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('dsh:remove', id, opts),
    setHome: (id: string, home: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('dsh:setHome', id, home),
    installOfficial: (options?: { versionDir?: string; name?: string; version?: string; force?: boolean }): Promise<IpcResult<{ id: string }>> =>
      ipcRenderer.invoke('dsh:installOfficial', options),
    pkgVersions: (): Promise<IpcResult<PackageVersionInfo>> =>
      ipcRenderer.invoke('dsh:pkgVersions'),
    getVersionDir: (): Promise<IpcResult<{ dir: string }>> =>
      ipcRenderer.invoke('dsh:getVersionDir'),
    setVersionDir: (dir: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('dsh:setVersionDir', dir),
    probe: (path?: string): Promise<IpcResult<DshEntry[]>> => ipcRenderer.invoke('dsh:probe', path),
    addManual: (alias: string, execPath: string): Promise<IpcResult<DshEntry>> =>
      ipcRenderer.invoke('dsh:addManual', alias, execPath),
    rename: (id: string, name: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('dsh:rename', id, name),
    revealDir: (id: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('dsh:revealDir', id),
    checkUpdate: (id: string): Promise<IpcResult<DshUpdateInfo | null>> =>
      ipcRenderer.invoke('dsh:checkUpdate', id),
    update: (id: string, opts?: { version?: string; ackMajorRisk?: boolean }): Promise<IpcResult<{ id: string }>> =>
      ipcRenderer.invoke('dsh:update', id, opts),
  },

  data: {
    export: (id: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('data:export', id),
    inspectImport: (): Promise<IpcResult<{ file: string; manifest: DshDataManifest | null }>> =>
      ipcRenderer.invoke('data:inspectImport'),
    import: (id: string, file: string, forceDsh?: boolean): Promise<IpcResult<DshDataImportResult>> =>
      ipcRenderer.invoke('data:import', id, file, forceDsh),
    mirror: (sourceId: string, targetId: string): Promise<IpcResult<DshDataImportResult>> =>
      ipcRenderer.invoke('data:mirror', sourceId, targetId),
  },

  logs: {
    reveal: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('logs:reveal'),
  },

  window: {
    minimize: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('window:toggleMaximize'),
    close: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('window:close'),
    quit: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('window:quit'),
    isMaximized: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('window:isMaximized'),
    chooseClose: (action: 'tray' | 'quit', remember: boolean): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('window:chooseClose', action, remember),
    onAskClose: (callback: (info: { running: string[] }) => void): (() => void) => {
      const handler = (_: unknown, info: { running: string[] }): void => callback(info)
      ipcRenderer.on('window:askClose', handler)
      return () => { ipcRenderer.removeListener('window:askClose', handler) }
    },
    onMaximizeState: (callback: (maximized: boolean) => void): (() => void) => {
      const handler = (_: unknown, maximized: boolean): void => callback(maximized)
      ipcRenderer.on('window:maximized', handler)
      return () => { ipcRenderer.removeListener('window:maximized', handler) }
    },
  },

  store: {
    needsMigration: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('store:needsMigration'),
    migrate: (): Promise<IpcResult<{ migrated: boolean }>> => ipcRenderer.invoke('store:migrate'),
  },

  app: {
    version: (): Promise<IpcResult<string>> => ipcRenderer.invoke('app:version'),
    checkUpdate: (): Promise<IpcResult<AppUpdateInfo>> => ipcRenderer.invoke('app:checkUpdate'),
  },
} satisfies WindowApi

contextBridge.exposeInMainWorld('api', api)