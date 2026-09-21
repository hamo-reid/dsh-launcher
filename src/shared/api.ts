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
  DevBuildTarget,
  DevDiagnoseOptions,
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
  ImportStep,
  InstalledOverviewRow,
  InstalledPlugin,
  InsertConflict,
  IpcResult,
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
  McpProbeResult,
  McpServer,
  McpServerInput,
  SkillEntry,
  SkillLibEntry,
  SkillLibIssue,
  SkillLibOverviewRow,
  SkillListing,
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
  /** Raw file access for the source editor; writes validate before landing. */
  readFile: (dshId: string, name: string, kind: ProfileFileKind) => Promise<IpcResult<{ text: string; path: string }>>
  writeFile: (dshId: string, name: string, kind: ProfileFileKind, text: string) => Promise<IpcResult<boolean>>
  /** Pre-launch composition check: parse, layers, conflicts and bundles. */
  validate: (dshId: string, name: string) => Promise<IpcResult<ProfileValidation>>
  /** Add/update a dependency (installs + reconciles bundle layers). */
  setDependency: (dshId: string, name: string, pkg: string, spec: string) => Promise<IpcResult<boolean>>
  removeDependency: (dshId: string, name: string, pkg: string) => Promise<IpcResult<boolean>>
  /** Update the manifest's display name and/or patch-file lifecycle. */
  setManifest: (dshId: string, name: string, meta: { displayName?: string; patchReload?: ProfilePatchReload }) => Promise<IpcResult<boolean>>
  /** Activate an installed package as a bundle layer. */
  addBundle: (dshId: string, name: string, pkg: string) => Promise<IpcResult<boolean>>
  /** Rename a profile's directory (refused while it is running). */
  rename: (dshId: string, oldName: string, newName: string) => Promise<IpcResult<boolean>>
  /** Reveal the profile's directory in the OS file explorer. */
  reveal: (dshId: string, name: string) => Promise<IpcResult<boolean>>
  /** Copy (or move) a profile's patch layer into another profile, merging by id. */
  transferPatch: (sourceDshId: string, sourceName: string, targetDshId: string, targetName: string, move: boolean) => Promise<IpcResult<boolean>>
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
    /** The home patch layer's raw text (source mode). */
    readPatch: (dshId: string) => Promise<IpcResult<{ text: string; path: string }>>
    writePatch: (dshId: string, text: string) => Promise<IpcResult<boolean>>
  }

  /** Extensions surface. Track A is MCP servers — the `insert:` rows that mount
   * `@deepseek-ai/dsh-mcp-client`, in the profile layer or the machine-level
   * home layer. */
  ext: {
    /** Every MCP row the profile resolves (bundle → profile → home), with
     * field-level and duplicate-`serverName` problems attached per row. */
    mcpList: (dshId: string, profile: string) => Promise<IpcResult<McpListing>>
    /** The dsh's home-layer MCP rows alone (the "every profile" scope). */
    mcpHomeList: (dshId: string) => Promise<IpcResult<McpServer[]>>
    /** Create or update one row in the chosen layer. */
    mcpSave: (dshId: string, profile: string, input: McpServerInput, layer: 'profile' | 'home') => Promise<IpcResult<boolean>>
    /** Remove one row; its `insert:` block goes with it when it was the last. */
    mcpRemove: (dshId: string, profile: string, id: string, layer: 'profile' | 'home') => Promise<IpcResult<boolean>>
    /** Reversible off switch — the row stays, dsh does not load it. */
    mcpSetDisabled: (dshId: string, profile: string, id: string, disabled: boolean, layer: 'profile' | 'home') => Promise<IpcResult<boolean>>
    /** Names of the launch secrets stored in the launcher (encrypted at rest,
     * injected into every dsh child). Values never leave the main process. */
    mcpSecrets: () => Promise<IpcResult<string[]>>
    /** Save (or, with `''`, clear) one launch secret. */
    mcpSecretSet: (name: string, value: string) => Promise<IpcResult<boolean>>
    /** Clear one launch secret (idempotent). */
    mcpSecretRemove: (name: string) => Promise<IpcResult<boolean>>
    /** Every root dsh scans for skills, the discovered catalog, and skill-like
     * files that would not load (with reasons). dsh-scoped, not per-profile. */
    skillList: (dshId: string) => Promise<IpcResult<SkillListing>>
    /** Move an editable skill to the OS recycle bin. */
    skillDelete: (dshId: string, name: string) => Promise<IpcResult<boolean>>
    // ── MCP library (launcher-global definitions; applied rows are copies) ──
    /** Every library entry with where it is applied and drift counts. */
    libMcpOverview: () => Promise<IpcResult<McpLibOverviewRow[]>>
    /** Create or update one library entry (`previousServerName` renames). */
    libMcpSave: (previousServerName: string | null, input: McpServerInput) => Promise<IpcResult<boolean>>
    /** Delete one library entry (applied rows are left untouched). */
    libMcpRemove: (serverName: string) => Promise<IpcResult<boolean>>
    /** Materialize a library entry as a row in a profile layer or the home
     * layer. Fails when the target layer already has a row of that name. */
    libMcpApply: (serverName: string, target: McpApplyTarget) => Promise<IpcResult<boolean>>
    /** Rewrite every drifted, non-handwritten applied row from the library. */
    libMcpSync: (serverName: string) => Promise<IpcResult<{ updated: number; skipped: number }>>
    /** Really connect to one library entry - a single initialize handshake, no
     * tools called - and report ok/reason/elapsed. A server that answers nothing
     * is a VALUE (`value.ok:false`), not an IPC failure, so the card can show
     * the reason inline instead of a toast. */
    libMcpTest: (serverName: string) => Promise<IpcResult<McpProbeResult>>
    // ── Skill library (launcher-global bundles; dsh roots hold copies) ──
    /** The library catalog plus every file that would not load (with reasons). */
    libSkillList: () => Promise<IpcResult<{ skills: SkillLibEntry[]; issues: SkillLibIssue[] }>>
    /** Entries with their per-dsh install states (installed / stale). */
    libSkillOverview: () => Promise<IpcResult<SkillLibOverviewRow[]>>
    /** Scaffold text for a new library skill. */
    libSkillScaffold: (name: string) => Promise<IpcResult<string>>
    /** Full text of one library skill, for the editor modal. */
    libSkillRead: (name: string) => Promise<IpcResult<{ text: string; path: string }>>
    /** Create (`previousName === null`) or update one library skill; the
     * frontmatter `name` is authoritative and renames the entry. */
    libSkillSave: (previousName: string | null, text: string) => Promise<IpcResult<SkillLibEntry>>
    /** Move one library skill to the OS recycle bin. */
    libSkillDelete: (name: string) => Promise<IpcResult<boolean>>
    /** Install a zip's skills into the library (all-or-nothing). With no
     * `zipPath` a file dialog picks the archive; a drag & drop passes its
     * resolved path. `null` when the dialog was cancelled. */
    libSkillImportZip: (zipPath?: string) => Promise<IpcResult<SkillLibEntry[] | null>>
    /** Copy a library skill into a dsh's writable root (`overwrite` = reinstall). */
    libSkillInstall: (name: string, dshId: string, overwrite: boolean) => Promise<IpcResult<SkillEntry>>
    /** Resolve a dropped file to its absolute path. The renderer cannot read
     * `File.path` (Electron removed it), only the preload can (`webUtils`).
     * Returns `''` when the file has no on-disk backing. */
    filePath: (file: File) => string
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
    addLocal: () => Promise<IpcResult<string>>
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
    /** Check store-installed plugins for a newer npm release (manual; cached). */
    checkUpdates: (opts?: { refresh?: boolean }) => Promise<IpcResult<PluginUpdateInfo[]>>
    /** Apply plugin version updates to a profile (refused while it runs). */
    applyUpdates: (dshId: string, profile: string, updates: { name: string; version: string }[]) => Promise<IpcResult<{ results: PluginApplyResult[] }>>
    /** Apply ONE plugin version to specific profiles (or archive it when the
     * target list is empty): downloads once, then re-points each profile.
     * `keepOld: false` also drops the now-unused older versions. */
    applyUpdate: (name: string, version: string, targets: { dshId: string; profile: string }[], opts?: { keepOld?: boolean }) => Promise<IpcResult<PluginUpdateResult>>
    /** Remove a plugin's unused archived versions (keeps the newest + in-use ones). */
    cleanupVersions: (name: string) => Promise<IpcResult<PluginCleanupResult>>
    /** Migrate a deprecated plugin to its replacement across every using profile. */
    migrateReplacement: (name: string, replacement: string) => Promise<IpcResult<PluginMigrationResult>>
    reveal: (name: string) => Promise<IpcResult<boolean>>
    readme: (name: string) => Promise<IpcResult<{ content: string; dir: string }>>
    search: (query: string, opts?: { from?: number; size?: number }) => Promise<IpcResult<{ hits: NpmSearchHit[]; total: number }>>
    /** Full version list + dist-tags for the version picker. */
    pkgVersions: (name: string) => Promise<IpcResult<PackageVersionInfo>>
    /** Local dev plugins: source dirs linked (not archived) into profiles, kept
     * in their own registry and managed separately from the store. */
    devList: () => Promise<IpcResult<{ plugins: DevPlugin[]; usage: Record<string, PluginUsagePoint[]> }>>
    /** Pick a package dir and register it as a dev plugin (no copy). */
    devAdd: () => Promise<IpcResult<DevPlugin>>
    /** Unregister; never touches the source dir or any profile. */
    devRemove: (name: string) => Promise<IpcResult<boolean>>
    /** Resolution diagnosis against one target (host + optional profile): entry,
     * patch rows (by their own `name:` or the package their `id:` is bound to) and
     * peers. Cached; `refresh` recomputes. */
    devDiagnose: (name: string, opts?: DevDiagnoseOptions) => Promise<IpcResult<DevDiagnosis>>
    /** Junction the host's copies of the missing peers into the dev package. */
    devShimPeers: (name: string, opts?: DevDiagnoseOptions) => Promise<IpcResult<{ added: string[]; skipped: string[] }>>
    devUnshimPeers: (name: string) => Promise<IpcResult<{ removed: string[] }>>
    /** The build scripts this dev plugin can run (its own + its workspace root's). */
    devScripts: (name: string) => Promise<IpcResult<{ options: DevScriptOptions; current?: DevBuildTarget }>>
    /** Run a build script (the remembered/default target unless one is given). */
    devBuild: (name: string, target?: DevBuildTarget) => Promise<IpcResult<DevRunResult>>
    /** Install the dev package's own deps (durable peer fix). */
    devInstall: (name: string) => Promise<IpcResult<DevRunResult>>
    /** Attach to a profile: `link` (live) or `copy` (snapshot then install). */
    devLinkToProfile: (dshId: string, profile: string, name: string, mode: DevLinkMode) => Promise<IpcResult<string>>
    devRepairLink: (dshId: string, profile: string, name: string, opts?: { inSource?: boolean }) => Promise<IpcResult<string>>
    /** Archive the current source state into the store (graduate). */
    devSnapshot: (name: string) => Promise<IpcResult<string>>
    devReveal: (name: string) => Promise<IpcResult<boolean>>
    devRevealWorkspace: (name: string) => Promise<IpcResult<boolean>>
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
    /** Subscribe to one-shot terminal-state pushes: a session that has just left
     * the live list (`done`/`failed`/`cancelled`), carrying its final message.
     * Returns an unsubscribe function. */
    onSettled: (fn: (session: DownloadSessionInfo) => void) => () => void
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
    /** Category / deprecation annotations for the installed-plugin overview. */
    annotations: () => Promise<IpcResult<MarketAnnotations>>
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
    /** GitHub API auth for update detection (token source / encryption / rate limit). */
    getGithubAuth: () => Promise<IpcResult<GithubAuthState>>
    /** Save (or clear, with `''`) the GitHub token; returns the new state. */
    setGithubToken: (token: string) => Promise<IpcResult<GithubAuthState>>
    /** Probe the live GitHub rate limit with the current token. */
    testGithubToken: () => Promise<IpcResult<GithubRateLimit>>
    /** Export settings to a user-chosen JSON file (`''` = cancelled). */
    exportSettings: () => Promise<IpcResult<string>>
    /** Import settings from a JSON file (`false` = cancelled). */
    importSettings: () => Promise<IpcResult<boolean>>
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