/**
 * The preload-exposed `window.api` contract — the single source of truth.
 *
 * Preload's implementation (`src/preload/index.ts`) is checked against this
 * interface (`satisfies WindowApi`); the renderer sees it via the global
 * `Window.api` declared in `src/preload/index.d.ts`.
 */
import type {
  AppUpdateInfo,
  ComboPlugin,
  DshDataImportResult,
  DshDataManifest,
  DshEntry,
  DshProfileInfo,
  DshUpdateInfo,
  DownloadSessionInfo,
  HealthIssue,
  ImportProfileResult,
  ImportStep,
  InstalledOverviewRow,
  InstalledPlugin,
  InsertConflict,
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
  RunDefaults,
  RunInfo,
  RunMode,
  LaunchOptions,
  TrashItem,
} from './types.ts'

export interface WindowApi {
  /** Every profile operation targets an explicit `dshId` — there is no global
   * active dsh. */
  listProfiles: (dshId: string) => Promise<IpcResult<string[]>>
  loadProfile: (dshId: string, name: string) => Promise<IpcResult<ProfileDetail>>
  setDisabled: (dshId: string, name: string, id: string, disabled: boolean) => Promise<IpcResult<boolean>>

  listProfileSummaries: (dshId: string) => Promise<IpcResult<ProfileSummary[]>>
  createProfile: (dshId: string, name: string, template?: string) => Promise<IpcResult<boolean>>
  cloneProfile: (dshId: string, name: string, newName: string) => Promise<IpcResult<boolean>>
  deleteProfile: (dshId: string, name: string) => Promise<IpcResult<boolean>>
  exportProfile: (dshId: string, name: string) => Promise<IpcResult<string>>
  exportToFile: (dshId: string, name: string, opts?: { zip?: boolean }) => Promise<IpcResult<string>>
  localBundles: (dshId: string, name: string) => Promise<IpcResult<string[]>>
  importFromFile: () => Promise<IpcResult<{ json: string; name: string; dshVersion: string; unpackDir: string }>>
  importProfile: (dshId: string, json: string, name?: string, forceDsh?: boolean, localSource?: string) => Promise<IpcResult<ImportProfileResult>>
  /** Copy a profile from one dsh to another (cross-version migration; source stays). */
  mirrorProfile: (sourceDshId: string, targetDshId: string, profileName: string) => Promise<IpcResult<ImportProfileResult>>
  /** Stream of per-step import progress (for the import dialog). Returns an unsubscribe. */
  onImportEvent: (callback: (step: ImportStep) => void) => () => void
  missingBundles: (dshId: string, name: string) => Promise<IpcResult<string[]>>
  layers: (dshId: string, name: string) => Promise<IpcResult<ProfileLayer[]>>
  /** Loader entry ids inserted by more than one composed layer (a boot-blocking
   * duplicate the host would otherwise only report as a raw stack trace). */
  conflicts: (dshId: string, name: string) => Promise<IpcResult<InsertConflict[]>>
  addRow: (dshId: string, name: string, row: RowCreateInput) => Promise<IpcResult<boolean>>
  setRowConfig: (dshId: string, name: string, id: string, configText: string) => Promise<IpcResult<boolean>>
  removeRow: (dshId: string, name: string, id: string) => Promise<IpcResult<boolean>>
  copyRow: (dshId: string, name: string, bundle: string, id: string) => Promise<IpcResult<boolean>>
  removeBundle: (dshId: string, name: string, bundle: string) => Promise<IpcResult<boolean>>
  /** Move a bundle layer to `toIndex` within the profile's bundle order. */
  reorderBundles: (dshId: string, name: string, bundle: string, toIndex: number) => Promise<IpcResult<boolean>>
  reconcileBundles: (dshId: string, name: string) => Promise<IpcResult<{ added: string[]; removed: string[] }>>
  configInfo: (dshId: string, name: string, id: string) => Promise<IpcResult<{ default: string; current: string }>>
  /** Open the profile's `cordis.patch.yml` in the OS default editor. */
  openPatchSource: (dshId: string, name: string) => Promise<IpcResult<boolean>>

  home: {
    setDisabled: (dshId: string, id: string, disabled: boolean) => Promise<IpcResult<boolean>>
  }

  run: {
    /** Start a profile runtime under an explicit `dshId`. Fails with
     * `run.alreadyRunning` when that (dsh, profile) already runs. When `mode` /
     * `options` are omitted the saved defaults are reused; explicit values are
     * validated and saved. Returns its run id. */
    start: (profile: string, mode: RunMode | undefined, options: LaunchOptions | undefined, dshId: string) => Promise<IpcResult<{ id: string }>>
    /** Stop one run by id. */
    stop: (id: string) => Promise<IpcResult<boolean>>
    /** Snapshot of every active run (no logs; fetch via `logs`). */
    list: () => Promise<IpcResult<RunInfo[]>>
    /** Full buffered output of one run. */
    logs: (id: string) => Promise<IpcResult<string>>
    /** Send one line to a run's stdin (app mode only). */
    input: (id: string, line: string) => Promise<IpcResult<boolean>>
    /** Saved default mode + launch parameters for a (dsh, profile). */
    getDefaults: (dshId: string, profile: string) => Promise<IpcResult<RunDefaults>>
    /** Validate + persist a profile's default mode + launch parameters. */
    setDefaults: (dshId: string, profile: string, defaults: RunDefaults) => Promise<IpcResult<boolean>>
    /** Pick a `.yml`/`.yaml` patch file; `''` when cancelled. */
    pickPatch: () => Promise<IpcResult<string>>
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
    installToProfile: (dshId: string, profile: string, pkg: string, version?: string) => Promise<IpcResult<string>>
    remove: (name: string, version?: string) => Promise<IpcResult<string>>
    /** Cascade full uninstall: detach the plugin from every using profile, then
     * remove the whole plugin (all versions) from the store. Returns the detached
     * usage points. */
    uninstall: (name: string) => Promise<IpcResult<{ removed: PluginUsagePoint[] }>>
    listCombo: (dshId: string, profile: string) => Promise<IpcResult<ComboPlugin[]>>
    overview: () => Promise<IpcResult<InstalledOverviewRow[]>>
    /** Size of each plugin (inode-dedup) — manual, triggered by the calc button. */
    calcSizes: () => Promise<IpcResult<Record<string, number>>>
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
    list: (dshId: string) => Promise<IpcResult<TrashItem[]>>
    restore: (dshId: string, name: string) => Promise<IpcResult<boolean>>
    delete: (dshId: string, name: string) => Promise<IpcResult<boolean>>
    empty: (dshId: string) => Promise<IpcResult<number>>
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
    onAskClose: (callback: (info: { running: string[] }) => void) => () => void
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
    list: () => Promise<IpcResult<{ dshes: DshEntry[] }>>
    /** Profile names under a SPECIFIC dsh — the Run page picks a launch target. */
    profiles: (id: string) => Promise<IpcResult<DshProfileInfo[]>>
    add: (path: string) => Promise<IpcResult<DshEntry>>
    remove: (id: string, opts?: { deleteFiles?: boolean }) => Promise<IpcResult<boolean>>
    setHome: (id: string, home: string) => Promise<IpcResult<boolean>>
    installOfficial: (options?: { versionDir?: string; name?: string; version?: string; force?: boolean }) => Promise<IpcResult<{ id: string }>>
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
    /** In-place update a managed dsh (cross-major needs `ackMajorRisk`). Returns the new session id. */
    update: (id: string, opts?: { version?: string; ackMajorRisk?: boolean }) => Promise<IpcResult<{ id: string }>>
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
    /** Whether a newer launcher release exists on GitHub. */
    checkUpdate: () => Promise<IpcResult<AppUpdateInfo>>
  }
}