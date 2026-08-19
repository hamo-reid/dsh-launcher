/**
 * The preload-exposed `window.api` contract — the single source of truth.
 *
 * Preload's implementation (`src/preload/index.ts`) is checked against this
 * interface (`satisfies WindowApi`); the renderer sees it via the global
 * `Window.api` declared in `src/preload/index.d.ts`.
 */
import type {
  ComboPlugin,
  DshEntry,
  DshInstallResult,
  DshInstallStep,
  ImportProfileResult,
  ImportStep,
  InstalledOverviewRow,
  InstalledPlugin,
  IpcResult,
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
} from './types.ts'

export interface WindowApi {
  listProfiles: () => Promise<IpcResult<string[]>>
  loadProfile: (name: string) => Promise<IpcResult<ProfileDetail>>
  setDisabled: (name: string, id: string, disabled: boolean) => Promise<IpcResult<boolean>>

  listProfileSummaries: () => Promise<IpcResult<ProfileSummary[]>>
  createProfile: (name: string, template?: string) => Promise<IpcResult<boolean>>
  cloneProfile: (name: string, newName: string) => Promise<IpcResult<boolean>>
  deleteProfile: (name: string) => Promise<IpcResult<boolean>>
  exportProfile: (name: string) => Promise<IpcResult<string>>
  exportToFile: (name: string, opts?: { zip?: boolean }) => Promise<IpcResult<string>>
  localBundles: (name: string) => Promise<IpcResult<string[]>>
  importFromFile: () => Promise<IpcResult<{ json: string; name: string; dshVersion: string; unpackDir: string }>>
  importProfile: (json: string, name?: string, forceDsh?: boolean, localSource?: string) => Promise<IpcResult<ImportProfileResult>>
  /** Stream of per-step import progress (for the import dialog). Returns an unsubscribe. */
  onImportEvent: (callback: (step: ImportStep) => void) => () => void
  missingBundles: (name: string) => Promise<IpcResult<string[]>>
  launchProfile: (name: string) => Promise<IpcResult<boolean>>
  layers: (name: string) => Promise<IpcResult<ProfileLayer[]>>
  addRow: (name: string, row: RowCreateInput) => Promise<IpcResult<boolean>>
  setRowConfig: (name: string, id: string, configText: string) => Promise<IpcResult<boolean>>
  removeRow: (name: string, id: string) => Promise<IpcResult<boolean>>
  copyRow: (name: string, bundle: string, id: string) => Promise<IpcResult<boolean>>
  removeBundle: (name: string, bundle: string) => Promise<IpcResult<boolean>>
  reconcileBundles: (name: string) => Promise<IpcResult<{ added: string[]; removed: string[] }>>
  configInfo: (name: string, id: string) => Promise<IpcResult<{ default: string; current: string }>>
  /** Open the profile's `cordis.patch.yml` in the OS default editor. */
  openPatchSource: (name: string) => Promise<IpcResult<boolean>>

  home: {
    load: () => Promise<IpcResult<{ rows: PluginRow[]; text: string }>>
    setDisabled: (id: string, disabled: boolean) => Promise<IpcResult<boolean>>
  }

  run: {
    start: (profile: string, mode?: 'app' | 'shell') => Promise<IpcResult<boolean>>
    stop: () => Promise<IpcResult<boolean>>
    state: () => Promise<IpcResult<{ running: boolean; profile?: string }>>
    command: () => Promise<IpcResult<string>>
    logs: () => Promise<IpcResult<string>>
    input: (line: string) => Promise<IpcResult<boolean>>
    openExternal: (url: string) => Promise<IpcResult<boolean>>
    onEvent: (callback: (event: RunEvent) => void) => () => void
  }

  plugins: {
    getDir: () => Promise<IpcResult<{ dir: string }>>
    setDir: (dir: string) => Promise<IpcResult<boolean>>
    list: () => Promise<IpcResult<InstalledPlugin[]>>
    add: (source: string) => Promise<IpcResult<string>>
    addLocal: (kind: 'folder' | 'zip') => Promise<IpcResult<string>>
    installOptions: () => Promise<IpcResult<{ id: string; name: string; version?: string; profiles: string[] }[]>>
    installToProfile: (profile: string, pkg: string, dshId?: string) => Promise<IpcResult<string>>
    remove: (name: string) => Promise<IpcResult<string>>
    listCombo: (profile: string) => Promise<IpcResult<ComboPlugin[]>>
    overview: () => Promise<IpcResult<InstalledOverviewRow[]>>
    reveal: (name: string) => Promise<IpcResult<boolean>>
    readme: (name: string) => Promise<IpcResult<{ content: string; dir: string }>>
    search: (query: string, opts?: { from?: number; size?: number }) => Promise<IpcResult<{ hits: NpmSearchHit[]; total: number }>>
    /** Full version list + dist-tags for the version picker. */
    pkgVersions: (name: string) => Promise<IpcResult<PackageVersionInfo>>
  }

  trash: {
    list: () => Promise<IpcResult<TrashItem[]>>
    restore: (name: string) => Promise<IpcResult<boolean>>
    delete: (name: string) => Promise<IpcResult<boolean>>
    empty: () => Promise<IpcResult<number>>
  }

  settings: {
    getUiLanguage: () => Promise<IpcResult<string | null>>
    setUiLanguage: (lng: string) => Promise<IpcResult<boolean>>
    getOnboardingState: () => Promise<IpcResult<OnboardingState>>
    pickDir: (opts?: { title?: string; defaultPath?: string }) => Promise<IpcResult<string>>
    completeOnboarding: (payload: OnboardingPayload) => Promise<IpcResult<boolean>>
  }

  logs: {
    /** Open the log directory in the OS file explorer. */
    reveal: () => Promise<IpcResult<boolean>>
  }

  window: {
    minimize: () => Promise<IpcResult<boolean>>
    toggleMaximize: () => Promise<IpcResult<boolean>>
    close: () => Promise<IpcResult<boolean>>
    isMaximized: () => Promise<IpcResult<boolean>>
    /** Push event mirroring maximize state (for the title-bar icon). Returns an unsubscribe. */
    onMaximizeState: (callback: (maximized: boolean) => void) => () => void
  }

  dsh: {
    list: () => Promise<IpcResult<{ dshes: DshEntry[]; activeDshId?: string }>>
    detect: () => Promise<IpcResult<DshEntry[]>>
    add: (path: string) => Promise<IpcResult<DshEntry>>
    remove: (id: string, opts?: { deleteFiles?: boolean }) => Promise<IpcResult<boolean>>
    setActive: (id: string) => Promise<IpcResult<boolean>>
    setHome: (id: string, home: string) => Promise<IpcResult<boolean>>
    setProfileDir: (id: string, dir: string) => Promise<IpcResult<boolean>>
    installOfficial: (options?: { versionDir?: string; name?: string; version?: string }) => Promise<IpcResult<DshInstallResult>>
    /** Streamed per-step progress of an official install (for the dialog). Returns an unsubscribe fn. */
    onInstallEvent: (callback: (step: DshInstallStep) => void) => () => void
    /** Published `@deepseek-ai/dsh` versions + dist-tags (for the official-install picker). */
    pkgVersions: () => Promise<IpcResult<PackageVersionInfo>>
    getVersionDir: () => Promise<IpcResult<{ dir: string }>>
    setVersionDir: (dir: string) => Promise<IpcResult<boolean>>
    probe: (path?: string) => Promise<IpcResult<DshEntry[]>>
    addManual: (alias: string, execPath: string) => Promise<IpcResult<DshEntry>>
    rename: (id: string, name: string) => Promise<IpcResult<boolean>>
    revealDir: (id: string) => Promise<IpcResult<boolean>>
  }
}