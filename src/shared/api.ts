/**
 * The preload-exposed `window.api` contract — the single source of truth.
 *
 * Preload's implementation (`src/preload/index.ts`) is checked against this
 * interface (`satisfies WindowApi`); the renderer sees it via the global
 * `Window.api` declared in `src/preload/index.d.ts`.
 */
import type {
  ComboPlugin,
  DshDataImportResult,
  DshDataManifest,
  DshEntry,
  DshInstallResult,
  DshInstallStep,
  DshUpdateInfo,
  DshUpdateResult,
  DownloadSessionInfo,
  HealthIssue,
  ImportProfileResult,
  ImportStep,
  InstalledOverviewRow,
  InstalledPlugin,
  IpcResult,
  PluginUsagePoint,
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
  /** Copy a profile from one dsh to another (cross-version migration; source stays). */
  mirrorProfile: (sourceDshId: string, targetDshId: string, profileName: string) => Promise<IpcResult<ImportProfileResult>>
  /** Stream of per-step import progress (for the import dialog). Returns an unsubscribe. */
  onImportEvent: (callback: (step: ImportStep) => void) => () => void
  missingBundles: (name: string) => Promise<IpcResult<string[]>>
  layers: (name: string) => Promise<IpcResult<ProfileLayer[]>>
  addRow: (name: string, row: RowCreateInput) => Promise<IpcResult<boolean>>
  setRowConfig: (name: string, id: string, configText: string) => Promise<IpcResult<boolean>>
  removeRow: (name: string, id: string) => Promise<IpcResult<boolean>>
  copyRow: (name: string, bundle: string, id: string) => Promise<IpcResult<boolean>>
  removeBundle: (name: string, bundle: string) => Promise<IpcResult<boolean>>
  /** Move a bundle layer to `toIndex` within the profile's bundle order. */
  reorderBundles: (name: string, bundle: string, toIndex: number) => Promise<IpcResult<boolean>>
  reconcileBundles: (name: string) => Promise<IpcResult<{ added: string[]; removed: string[] }>>
  configInfo: (name: string, id: string) => Promise<IpcResult<{ default: string; current: string }>>
  /** Open the profile's `cordis.patch.yml` in the OS default editor. */
  openPatchSource: (name: string) => Promise<IpcResult<boolean>>

  home: {
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
    add: (source: string, name?: string) => Promise<IpcResult<string>>
    addLocal: (kind: 'folder' | 'zip') => Promise<IpcResult<string>>
    installOptions: () => Promise<IpcResult<{ id: string; name: string; version?: string; profiles: string[] }[]>>
    installToProfile: (profile: string, pkg: string, version?: string, dshId?: string) => Promise<IpcResult<string>>
    remove: (name: string, version?: string) => Promise<IpcResult<string>>
    /** Cascade full uninstall: detach the plugin from every using profile, then
     * remove the whole plugin (all versions) from the store. Returns the detached
     * usage points. */
    uninstall: (name: string) => Promise<IpcResult<{ removed: PluginUsagePoint[] }>>
    listCombo: (profile: string) => Promise<IpcResult<ComboPlugin[]>>
    overview: () => Promise<IpcResult<InstalledOverviewRow[]>>
    reveal: (name: string) => Promise<IpcResult<boolean>>
    readme: (name: string) => Promise<IpcResult<{ content: string; dir: string }>>
    search: (query: string, opts?: { from?: number; size?: number }) => Promise<IpcResult<{ hits: NpmSearchHit[]; total: number }>>
    /** Full version list + dist-tags for the version picker. */
    pkgVersions: (name: string) => Promise<IpcResult<PackageVersionInfo>>
  }

  /** Cancellable, parallel plugin download sessions (global download panel). */
  downloads: {
    start: (source: string, name?: string) => Promise<IpcResult<{ id: string }>>
    list: () => Promise<IpcResult<DownloadSessionInfo[]>>
    cancel: (id: string) => Promise<IpcResult<boolean>>
    cleanup: () => Promise<IpcResult<{ removed: string[] }>>
    /** Subscribe to live session-snapshot pushes from the main process. Returns
     * an unsubscribe function. */
    onChange: (fn: (list: DownloadSessionInfo[]) => void) => () => void
  }

  market: {
    /** Fetch one page of the community catalog for the current route, applying
     * the query (q/category/sort) in the main process. By default serves the
     * memoized catalog so paging/search/sort are instant local slices; pass
     * `refresh: true` (manual refresh, retry) to revalidate over the network.
     * Throws (→ IpcResult failure) when a network load is unreachable. Returns
     * a bounded slice + total, never the whole catalog. */
    list: (opts?: MarketListOpts) => Promise<IpcResult<MarketPage>>
    /** Current loading route (persisted), for the pipeline picker. */
    source: () => Promise<IpcResult<MarketSourceState>>
    /** Persist a loading-route change (`false` when the custom URL is invalid). */
    setSource: (next: MarketSourceState) => Promise<IpcResult<boolean>>
    /** Resolve one catalog entry (by url) to its install spec + meta. */
    resolve: (url: string) => Promise<IpcResult<{ spec: string | null; plugin: MarketPlugin | null }>>
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
    /** Disk-vs-app sync health: missing dsh executables / homes / store / plugins. */
    checkHealth: () => Promise<IpcResult<HealthIssue[]>>
    /** Whether clicking close minimizes to tray instead of quitting. */
    getCloseToTray: () => Promise<IpcResult<boolean>>
    setCloseToTray: (enabled: boolean) => Promise<IpcResult<boolean>>
    /** Whether clicking close asks the user each time. */
    getAskOnClose: () => Promise<IpcResult<boolean>>
    setAskOnClose: (enabled: boolean) => Promise<IpcResult<boolean>>
    /** Bundled/system Node versions + which one dsh launches with. */
    getNodeEnvironment: () => Promise<IpcResult<NodeEnvironment>>
    /** Persist which node to use for launching dsh (`'system'` | `'bundled'`). */
    setNodePreference: (preference: 'system' | 'bundled') => Promise<IpcResult<boolean>>
  }

  logs: {
    /** Open the log directory in the OS file explorer. */
    reveal: () => Promise<IpcResult<boolean>>
  }

  window: {
    minimize: () => Promise<IpcResult<boolean>>
    toggleMaximize: () => Promise<IpcResult<boolean>>
    close: () => Promise<IpcResult<boolean>>
    /** Hard quit — bypasses the minimize-to-tray close guard (migration "exit"). */
    quit: () => Promise<IpcResult<boolean>>
    isMaximized: () => Promise<IpcResult<boolean>>
    /** Resolve a close prompt: minimize-to-tray (`'tray'`) or quit; `remember`
     * persists the choice as the close behaviour and stops future prompts. */
    chooseClose: (action: 'tray' | 'quit', remember: boolean) => Promise<IpcResult<boolean>>
    /** Push event asking the renderer to show the minimize/quit close prompt. Returns an unsubscribe. */
    onAskClose: (callback: (info: { running?: string }) => void) => () => void
    /** Push event mirroring maximize state (for the title-bar icon). Returns an unsubscribe. */
    onMaximizeState: (callback: (maximized: boolean) => void) => () => void
  }

  store: {
    /** Whether the plugin store still holds legacy flat packages awaiting the
     * one-time legacy → versioned migration. Read-only probe for the consent dialog. */
    needsMigration: () => Promise<IpcResult<boolean>>
    /** Run the one-time migration after the user consents. Idempotent no-op when already versioned. */
    migrate: () => Promise<IpcResult<{ migrated: boolean }>>
  }

  dsh: {
    list: () => Promise<IpcResult<{ dshes: DshEntry[]; activeDshId?: string }>>
    add: (path: string) => Promise<IpcResult<DshEntry>>
    remove: (id: string, opts?: { deleteFiles?: boolean }) => Promise<IpcResult<boolean>>
    setActive: (id: string) => Promise<IpcResult<boolean>>
    setHome: (id: string, home: string) => Promise<IpcResult<boolean>>
    setProfileDir: (id: string, dir: string) => Promise<IpcResult<boolean>>
    installOfficial: (options?: { versionDir?: string; name?: string; version?: string; force?: boolean }) => Promise<IpcResult<DshInstallResult>>
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
    /** Whether a managed dsh has a newer release. `null` = up to date. */
    checkUpdate: (id: string) => Promise<IpcResult<DshUpdateInfo | null>>
    /** In-place update a managed dsh (cross-major needs `ackMajorRisk`). */
    update: (id: string, opts?: { version?: string; ackMajorRisk?: boolean }) => Promise<IpcResult<DshUpdateResult>>
  }

  data: {
    /** Export a dsh's migratable data to a user-chosen zip. `''` = cancelled. */
    export: (id: string) => Promise<IpcResult<string>>
    /** Pick an archive and read its manifest (for the cross-version gate). */
    inspectImport: () => Promise<IpcResult<{ file: string; manifest: DshDataManifest | null }>>
    /** Import an archive into a dsh's home (cross-major needs `forceDsh`). */
    import: (id: string, file: string, forceDsh?: boolean) => Promise<IpcResult<DshDataImportResult>>
    /** Directly mirror one dsh's data into another dsh's home. */
    mirror: (sourceId: string, targetId: string) => Promise<IpcResult<DshDataImportResult>>
  }

  app: {
    /** The packaged app version (for the About page). */
    version: () => Promise<IpcResult<string>>
  }
}