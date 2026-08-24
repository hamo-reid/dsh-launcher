/** Preload: expose a type-safe, whitelisted `window.api` to the renderer.
 * The contract lives in `src/shared/api.ts`; this object is checked against it
 * so the implementation can never drift from what the renderer sees. */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  ComboPlugin,
  DshDataImportResult,
  DshDataManifest,
  DshEntry,
  DshInstallResult,
  DshInstallStep,
  DshUpdateInfo,
  DshUpdateResult,
  HealthIssue,
  ImportProfileResult,
  ImportStep,
  InstalledOverviewRow,
  IpcResult,
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
  ProfileLayer,
  ProfileSummary,
  RowCreateInput,
  RunEvent,
  TrashItem,
} from '../shared/types.ts'
import type { WindowApi } from '../shared/api.ts'

const api = {
  listProfiles: (): Promise<IpcResult<string[]>> => ipcRenderer.invoke('profile:list'),
  loadProfile: (name: string): Promise<IpcResult<ProfileDetail>> =>
    ipcRenderer.invoke('profile:load', name),
  setDisabled: (name: string, id: string, disabled: boolean): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:setDisabled', name, id, disabled),

  listProfileSummaries: (): Promise<IpcResult<ProfileSummary[]>> => ipcRenderer.invoke('profile:summaries'),
  createProfile: (name: string, template?: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:create', name, template),
  cloneProfile: (name: string, newName: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:clone', name, newName),
  deleteProfile: (name: string): Promise<IpcResult<boolean>> => ipcRenderer.invoke('profile:delete', name),
  exportProfile: (name: string): Promise<IpcResult<string>> => ipcRenderer.invoke('profile:export', name),
  exportToFile: (name: string, opts?: { zip?: boolean }): Promise<IpcResult<string>> =>
    ipcRenderer.invoke('profile:exportToFile', name, opts),
  localBundles: (name: string): Promise<IpcResult<string[]>> => ipcRenderer.invoke('profile:localBundles', name),
  importFromFile: (): Promise<IpcResult<{ json: string; name: string; dshVersion: string; unpackDir: string }>> =>
    ipcRenderer.invoke('profile:importFromFile'),
  importProfile: (json: string, name?: string, forceDsh?: boolean, localSource?: string): Promise<IpcResult<ImportProfileResult>> =>
    ipcRenderer.invoke('profile:import', json, name, forceDsh, localSource),
  mirrorProfile: (sourceDshId: string, targetDshId: string, profileName: string): Promise<IpcResult<ImportProfileResult>> =>
    ipcRenderer.invoke('profile:mirror', sourceDshId, targetDshId, profileName),
  onImportEvent: (callback: (step: ImportStep) => void): (() => void) => {
    const handler = (_: unknown, step: ImportStep): void => callback(step)
    ipcRenderer.on('import:event', handler)
    return () => { ipcRenderer.removeListener('import:event', handler) }
  },
  missingBundles: (name: string): Promise<IpcResult<string[]>> =>
    ipcRenderer.invoke('profile:missingBundles', name),
  launchProfile: (name: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:launch', name),
  layers: (name: string): Promise<IpcResult<ProfileLayer[]>> =>
    ipcRenderer.invoke('profile:layers', name),
  addRow: (name: string, row: RowCreateInput): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:addRow', name, row),
  setRowConfig: (name: string, id: string, configText: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:setRowConfig', name, id, configText),
  removeRow: (name: string, id: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:removeRow', name, id),
  copyRow: (name: string, bundle: string, id: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:copyRow', name, bundle, id),
  removeBundle: (name: string, bundle: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:removeBundle', name, bundle),
  reorderBundles: (name: string, bundle: string, toIndex: number): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:reorderBundle', name, bundle, toIndex),
  reconcileBundles: (name: string): Promise<IpcResult<{ added: string[]; removed: string[] }>> =>
    ipcRenderer.invoke('profile:reconcile', name),
  configInfo: (name: string, id: string): Promise<IpcResult<{ default: string; current: string }>> =>
    ipcRenderer.invoke('profile:configInfo', name, id),
  openPatchSource: (name: string): Promise<IpcResult<boolean>> =>
    ipcRenderer.invoke('profile:openPatchSource', name),

  home: {
    load: (): Promise<IpcResult<{ rows: PluginRow[]; text: string }>> =>
      ipcRenderer.invoke('home:load'),
    setDisabled: (id: string, disabled: boolean): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('home:setDisabled', id, disabled),
  },

  run: {
    start: (profile: string, mode?: 'app' | 'shell'): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('run:start', profile, mode),
    stop: (): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('run:stop'),
    state: (): Promise<IpcResult<{ running: boolean; profile?: string }>> =>
      ipcRenderer.invoke('run:state'),
    command: (): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('run:command'),
    logs: (): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('run:logs'),
    input: (line: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('run:input', line),
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
    list: (): Promise<IpcResult<{ name: string; version: string }[]>> =>
      ipcRenderer.invoke('plugins:list'),
    add: (source: string, name?: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:add', source, name),
    addLocal: (kind: 'folder' | 'zip'): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:addLocal', kind),
    installToProfile: (profile: string, pkg: string, version?: string, dshId?: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:installToProfile', profile, pkg, version, dshId),
    installOptions: (): Promise<IpcResult<{ id: string; name: string; version?: string; profiles: string[] }[]>> =>
      ipcRenderer.invoke('plugins:installOptions'),
    remove: (name: string, version?: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:remove', name, version),
    listCombo: (profile: string): Promise<IpcResult<ComboPlugin[]>> =>
      ipcRenderer.invoke('plugins:listCombo', profile),
    overview: (): Promise<IpcResult<InstalledOverviewRow[]>> =>
      ipcRenderer.invoke('plugins:overview'),
    reveal: (name: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('plugins:reveal', name),
    readme: (name: string): Promise<IpcResult<{ content: string; dir: string }>> =>
      ipcRenderer.invoke('plugins:readme', name),
    search: (query: string, opts?: { from?: number; size?: number }): Promise<IpcResult<{ hits: NpmSearchHit[]; total: number }>> =>
      ipcRenderer.invoke('plugins:search', query, opts),
    pkgVersions: (name: string): Promise<IpcResult<PackageVersionInfo>> =>
      ipcRenderer.invoke('plugins:pkgVersions', name),
  },

  market: {
    list: (opts?: MarketListOpts): Promise<IpcResult<MarketPage>> =>
      ipcRenderer.invoke('market:list', opts),
    source: (): Promise<IpcResult<MarketSourceState>> => ipcRenderer.invoke('market:source'),
    setSource: (next: MarketSourceState): Promise<IpcResult<boolean>> => ipcRenderer.invoke('market:setSource', next),
    resolve: (url: string): Promise<IpcResult<{ spec: string | null; plugin: MarketPlugin | null }>> =>
      ipcRenderer.invoke('market:resolve', url),
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
  },

  trash: {
    list: (): Promise<IpcResult<TrashItem[]>> =>
      ipcRenderer.invoke('trash:list'),
    restore: (name: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('trash:restore', name),
    delete: (name: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('trash:delete', name),
    empty: (): Promise<IpcResult<number>> =>
      ipcRenderer.invoke('trash:empty'),
  },

  dsh: {
    list: (): Promise<IpcResult<{ dshes: DshEntry[]; activeDshId?: string }>> =>
      ipcRenderer.invoke('dsh:list'),
    detect: (): Promise<IpcResult<DshEntry[]>> => ipcRenderer.invoke('dsh:detect'),
    add: (path: string): Promise<IpcResult<DshEntry>> =>
      ipcRenderer.invoke('dsh:add', path),
    remove: (id: string, opts?: { deleteFiles?: boolean }): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('dsh:remove', id, opts),
    setActive: (id: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('dsh:setActive', id),
    setHome: (id: string, home: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('dsh:setHome', id, home),
    setProfileDir: (id: string, dir: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('dsh:setProfileDir', id, dir),
    installOfficial: (options?: { versionDir?: string; name?: string; version?: string }): Promise<IpcResult<DshInstallResult>> =>
      ipcRenderer.invoke('dsh:installOfficial', options),
    onInstallEvent: (callback: (step: DshInstallStep) => void): (() => void) => {
      const handler = (_: unknown, step: DshInstallStep): void => callback(step)
      ipcRenderer.on('install:event', handler)
      return () => { ipcRenderer.removeListener('install:event', handler) }
    },
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
    update: (id: string, opts?: { version?: string; ackMajorRisk?: boolean }): Promise<IpcResult<DshUpdateResult>> =>
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
    onAskClose: (callback: (info: { running?: string }) => void): (() => void) => {
      const handler = (_: unknown, info: { running?: string }): void => callback(info)
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
  },
} satisfies WindowApi

contextBridge.exposeInMainWorld('api', api)