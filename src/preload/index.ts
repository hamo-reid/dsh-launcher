/** Preload: expose a type-safe, whitelisted `window.api` to the renderer.
 * The contract lives in `src/shared/api.ts`; this object is checked against it
 * so the implementation can never drift from what the renderer sees. */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  ComboPlugin,
  DshEntry,
  ImportProfileResult,
  ImportStep,
  InstalledOverviewRow,
  IpcResult,
  NpmSearchHit,
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
    add: (source: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:add', source),
    addLocal: (kind: 'folder' | 'zip'): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:addLocal', kind),
    installToProfile: (profile: string, pkg: string, dshId?: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:installToProfile', profile, pkg, dshId),
    installOptions: (): Promise<IpcResult<{ id: string; name: string; version?: string; profiles: string[] }[]>> =>
      ipcRenderer.invoke('plugins:installOptions'),
    remove: (name: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke('plugins:remove', name),
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

  settings: {
    getUiLanguage: (): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke('settings:getUiLanguage'),
    setUiLanguage: (lng: string): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('settings:setUiLanguage', lng),
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
    installOfficial: (options?: { versionDir?: string; name?: string }): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('dsh:installOfficial', options),
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
  },
} satisfies WindowApi

contextBridge.exposeInMainWorld('api', api)