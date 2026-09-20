/**
 * Shared types across the main-process service, preload/IPC boundary, and the
 * renderer — the single source of truth for cross-process shapes.
 *
 * Main/core re-exports these (see `src/main/core/types.ts` and the domain
 * modules) so existing import paths stay valid; renderer and preload should
 * import directly from here.
 */

// ── patch / profile layering ────────────────────────────────────────────────

/** One plugin row visible in the UI: a `- id: ...` entry in a cordis patch layer. */
export interface PluginRow {
  /** Row id (the `- id:` value). */
  id: string
  /** Whether this layer row is disabled. */
  disabled: boolean
}

/** One patch row classified for the layer stack: its block's shape. */
export interface ClassifiedRow {
  id: string
  /** Package name the row mounts, when the block declares one. */
  name?: string
  disabled: boolean
  hasConfig: boolean
  hasInsert: boolean
}

/** A layer within the composed profile stack (application order). */
export interface ProfileLayer {
  /** Where this layer comes from. */
  source: 'bundle' | 'profile' | 'home'
  /** Bundle package name when `source === 'bundle'`. */
  bundle?: string
  /** Profile name when `source === 'profile'`. */
  label?: string
  rows: ClassifiedRow[]
}

/** One layer of a profile's composed stack, for insert-conflict reporting. */
export interface InsertConflictLayer {
  source: 'bundle' | 'profile' | 'home' | 'patch'
  /** Bundle package name (`source === 'bundle'`). */
  bundle?: string
  /** Profile name (`source === 'profile'`) or overlay filename (`source === 'patch'`). */
  label?: string
}

/** A loader entry id inserted by more than one layer of a profile's composed
 * patch stack. The host applies each layer's inserts in order and hard-fails on
 * a repeated entry id (`duplicate loader entry id`), so this profile cannot boot. */
export interface InsertConflict {
  id: string
  /** Every layer that inserts this id, in application order. */
  layers: InsertConflictLayer[]
}

/** A raw, user-editable file of a profile (source mode). */
export type ProfileFileKind = 'manifest' | 'patch'

/** Pre-launch composition check for one profile. */
export interface ProfileValidation {
  /** True when nothing blocks a boot. */
  ok: boolean
  /** `package.json` parse/shape error, when malformed. */
  manifestError?: string
  /** `cordis.patch.yml` parse/shape error, when malformed. */
  patchError?: string
  /** Entry ids inserted by more than one layer (boot-blocking). */
  conflicts: InsertConflict[]
  /** Listed bundles whose patch cannot be resolved (missing install). */
  missingBundles: string[]
  /** Installed bundles not activated as a layer. */
  unclaimedBundles: string[]
}

/** Input for creating/updating a row in the profile layer's patch. */
export interface RowCreateInput {
  id: string
  disabled?: boolean
  config?: string
  insert?: string[]
}

/** The user patch-file lifecycle a profile manifest declares
 * (`dsh.profile.patchReload`): `live` watches and hot-reloads the patch file,
 * `startup` reads it once at boot. */
export type ProfilePatchReload = 'live' | 'startup'

/** One point where a plugin is in use: a profile under some dsh. */
export interface PluginUsagePoint {
  dsh: string
  dshVersion?: string
  profile: string
  /** The resolved version of this plugin actually installed in the profile's
   * `node_modules` (read from its `package.json`). Absent when the profile has
   * not been installed yet, or the plugin isn't resolved into its node_modules. */
  version?: string
}

/** How an archived plugin version got into the store. `dsh` = shipped with the
 * harness (never archived); `store` = archived but its origin predates source
 * tracking (unresolved). */
export type PluginSource = 'github' | 'npm' | 'local' | 'dsh' | 'store'

/** The origin dimension, distinct from the kind/role dimension: how a plugin
 * entered the store. `unknown` = archived before origin tracking existed. */
export type PluginOrigin = 'npm' | 'github' | 'local' | 'unknown'

/** What role a plugin currently plays for profiles.
 * - `template`   — a dsh-shipped bundle (used but never in the store)
 * - `bundle`     — activated as a `dsh.profile.bundles` layer somewhere
 * - `dependency` — used (installed into a profile) but not a bundle layer
 * - `store-only` — archived in the store but used by no profile */
export type PluginKind = 'template' | 'bundle' | 'dependency' | 'store-only'

/** The management/source axis, orthogonal to `PluginKind` (role): how a plugin
 * is sourced for the profiles that use it.
 * - `store`      — archived in the launcher plugin store (manageable)
 * - `official`   — shipped by the dsh install (resolved from its install anchor)
 * - `sub-bundle` — child package of an aggregate bundle (reserved; not yet detected)
 * - `local-link` — profile dependency is a link:/file: outside the store
 * - `external`   — resolved from node_modules but not launcher-managed */
export type PluginProvenance = 'store' | 'official' | 'sub-bundle' | 'local-link' | 'external'

/** Per-plugin update check result. npm-backed plugins compare against the
 * registry's `latest` dist-tag; github-only / local origins have no reliable
 * version source and are reported as `manual`. */
export interface PluginUpdateInfo {
  name: string
  origin: PluginOrigin
  /** Versions resolved in profiles (unique, non-empty). */
  applied: string[]
  /** Versions archived in the store (unique). */
  archived: string[]
  /** Latest installable version (npm `latest`), when known. */
  latest?: string
  /** True when `latest` is newer than every applied/archived version. */
  updateAvailable: boolean
  /** True when the origin cannot be auto-checked (github / local). */
  manual: boolean
}

/** Outcome of applying one plugin version update to a profile. */
export interface PluginApplyResult {
  name: string
  version: string
  ok: boolean
  text: string
}

/** Result of garbage-collecting a plugin's unused archived versions. */
export interface PluginCleanupResult {
  removed: string[]
}

/** Result of migrating a deprecated plugin to its replacement. */
export interface PluginMigrationResult {
  /** The package name the profiles were migrated to. */
  target: string
  /** Profiles that received the replacement. */
  installed: number
  /** Profiles the deprecated plugin was detached from. */
  detached: number
}

/** One plugin's catalog-derived annotations (category + deprecation). */
export interface MarketAnnotation {
  category: string
  /** Catalog entry name (the repo package name), for display. */
  name?: string
  deprecated?: boolean
  replacement?: string
}

/** Catalog annotations keyed by npm name (falling back to the catalog name),
 * for decorating the installed-plugin overview with category / deprecation. */
export interface MarketAnnotations {
  categories: Record<string, Record<string, string>>
  plugins: Record<string, MarketAnnotation>
}

/** Lifecycle state of a download task. */
export type DownloadStatus = 'running' | 'done' | 'failed' | 'cancelled'

/** What kind of install a download session represents. */
export type DownloadKind = 'plugin' | 'dsh'

/** Per-step state of a task that has visible multi-stage progress (dsh install). */
export type DownloadStepStatus = 'running' | 'ok' | 'error'

/** One progress step of a multi-stage task (e.g. dsh install: version→install→register). */
export interface DownloadStep {
  /** Step key — maps to a localized label (`dsh.official.step.<key>` for dsh). */
  key: string
  status: DownloadStepStatus
  detail?: string
  /** Optional short tag, e.g. the resolved version number. */
  meta?: string
}

/** One download task (plugin or dsh), visible to the renderer's global download panel. */
export interface DownloadSessionInfo {
  id: string
  kind: DownloadKind
  /** Display/install name (package name, or dsh install name). */
  name: string
  /** The pnpm source spec (`name@ver`, `github:owner/repo`, `file:…`) — plugin only. */
  source: string
  /** Secondary line: plugin = the source spec; dsh = target version / description. */
  detail?: string
  status: DownloadStatus
  /** Failure/cancel detail, when any. */
  message?: string
  /** Live progress steps (dsh only; plugins run as a single front-and-back step). */
  steps?: DownloadStep[]
}

/** One row of the installed-plugin overview. */
export interface InstalledOverviewRow {
  name: string
  versions: string[]
  usage: PluginUsagePoint[]
  inStore: boolean
  /** Distinct origins of the archived versions (GitHub / npm / local folder),
   * plus `dsh` when it is a built-in template. Empty when nothing resolved. */
  sources: PluginSource[]
  /** The origin dimension derived from the archived versions. */
  origin?: PluginOrigin
  /** The role this plugin currently plays for profiles. */
  kind?: PluginKind
  /** Every distinct management source observed across usage points + the store,
   * ordered most-manageable first (see `primary` = `provenances[0]`). */
  provenances?: PluginProvenance[]
  /** True for a dsh-bundled template (used by a profile but not in the store):
   * shown as built-in, not a manageable plugin. */
  builtin?: boolean
  /** Real on-disk bytes of this plugin's own files (inode-dedup across its archive
   * versions / profile copy). Absent when nothing resolved on disk. */
  sizeBytes?: number
}

/** What `profile:load` returns for one profile. */
export interface ProfileDetail {
  /** Ordered `dsh.profile.bundles` layer list. */
  bundles: string[]
  /** Profile manifest `dependencies` (package names). */
  dependencies: string[]
  /** Manifest `dependencies` with their version/source specs, for editing. */
  dependencySpecs: Record<string, string>
  /** Manifest display name (`name`), falling back to the profile name. */
  displayName: string
  /** Manifest `dsh.profile.patchReload`, defaulting to `live`. */
  patchReload: ProfilePatchReload
  /** The profile's own user-patch rows (from its `cordis.patch.yml`). */
  rows: PluginRow[]
  /** The profile's `cordis.patch.yml` content (view-only). */
  patchText: string
}

/** Uniform IPC result envelope. The failure side carries a stable error `code`
 * (mapped to localized text in the renderer via `t('errors.<code>')`) plus the
 * raw `error` string as a fallback/detail. */
export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; params?: Record<string, string> | string[]; error: string; conflicts?: InsertConflict[] }

/** Launch mode for a profile runtime: embedded console (`app`) or a visible OS
 * terminal window (`shell`). Both are owned/tracked by the main process. */
export type RunMode = 'app' | 'shell'

/** Per-profile launch parameters, persisted as defaults and overridable per run.
 * All fields optional; the main process normalizes/validates them. */
export interface LaunchOptions {
  /** Extra argv appended AFTER `--profile <name>` — passed through to the booted
   * app (e.g. `--resume abc`). Launcher flags (`--profile`/`--patch`/…) rejected. */
  args?: string[]
  /** Repeatable `--patch <file>` overlays applied after the profile's own layers. */
  patches?: string[]
  /** Extra child environment variables. Reserved keys are rejected. */
  env?: Record<string, string>
  /** Convenience web server port; compiled to `--port <n>` in the pass-through
   * args (web profiles only). `0` lets the OS pick a free port. */
  port?: number
}

/** Serializable snapshot of one profile runtime. Logs are NOT included (they can
 * be large) — fetch them on demand with `run.logs(id)`. */
export interface RunInfo {
  /** Stable run id (`<profile>#<seq>`); survives renderer reloads. */
  id: string
  /** The dsh install that owns this run — runs may span several dsh. */
  dshId: string
  dshName: string
  profile: string
  mode: RunMode
  /** Epoch ms the run started — drives the elapsed-time display. */
  startedAt: number
  /** Joined launch argv, for diagnostics. */
  command: string
  status: 'running' | 'exited'
  /** Exit code / signal, present once `status === 'exited'`. */
  code?: number | null
  signal?: NodeJS.Signals | null
}

/** Saved per-profile run defaults: the mode to launch with plus its launch
 * parameters. Stored under `<dshId>::<profile>` in app settings. */
export interface RunDefaults {
  mode: RunMode
  options: LaunchOptions
}

/** Streamed status of a profile runtime (main → renderer via `run:event`). Every
 * event carries the run `id` so the renderer can demultiplex concurrent runs. */
export type RunEvent =
  | { type: 'started'; run: RunInfo }
  | { type: 'output'; id: string; line: string }
  | { type: 'exited'; run: RunInfo }

// ── dsh installs ────────────────────────────────────────────────────────────

/** One registered/detected dsh install. */
export interface DshEntry {
  id: string
  name: string
  execPath: string
  version: string
  /** This dsh's own data home (profiles live under `<home>/profiles`). */
  home: string
  /** Effective (resolved) profiles directory, computed at read time: always
   * `<home>/profiles`. */
  profileDir?: string
  /** A legacy profiles-dir override still persisted in settings. Ignored for
   * every operation (profiles always live at `<home>/profiles`); present only so
   * the DSH page can point the user at data that predates the fix. */
  legacyProfilesDir?: string
  /** Persisted app-managed marker (set on official install; the read side merges
   * it with a path-derived check so a clobbered marker still leaves an app
   * install deletable). System/globally-installed dsh are never managed. */
  managed?: boolean
  /** The version-repo root this install landed in (official installs only).
   * Lets delete/cleanup anchor to the actual install dir even when the current
   * `dshVersionDir` setting has since changed. Absent on legacy entries. */
  versionDir?: string
  /** User-friendly base launch command (e.g. `pnpm dsh`), derived at read time. */
  launch?: string
  /** Directory holding this dsh's executable (derived, for reveal-in-explorer). */
  dir?: string
}

// ── health check (disk ↔ app sync) ───────────────────────────────────────────

/** What a health check flagged on the disk vs. the app's recorded state. */
export type HealthIssueKind =
  /** A registered dsh's executable no longer exists on disk. */
  | 'dsh-exec'
  /** The dsh executable exists but its launch entry is unresolvable (incomplete install). */
  | 'dsh-broken'
  /** No plugin store location is configured. */
  | 'store-unconfigured'
  /** The plugin store dir is configured but does not exist on disk. */
  | 'store-missing'
  /** A catalogued store plugin's node_modules dir is missing on disk. */
  | 'plugin-missing'

/** One flagged discrepancy, surfaced by `settings:checkHealth`. */
export interface HealthIssue {
  kind: HealthIssueKind
  /** Dsh name / plugin name / 'plugin store'. */
  label: string
  path?: string
  missing: boolean
}

// ── node runtime detection ───────────────────────────────────────────────────

/** Which node the launcher will run dsh with, + the versions it detected. */
export interface NodeEnvironment {
  /** The app's bundled Node version (process.versions.node). */
  bundled: string
  /** A system `node` on PATH, if any. */
  system: { installed: boolean; version: string }
  /** The user's explicit choice (`'system'` = use system node when usable). */
  preference: 'system' | 'bundled'
  /** The node actually used to run dsh (after fallback if the choice is unusable). */
  prefer: 'system' | 'bundled'
}

// ── launcher self-update (GitHub releases) ───────────────────────────────────

/** One launcher GitHub release (normalised; leading `v` stripped). */
export interface AppRelease {
  /** Tag without the leading `v` (e.g. `0.2.0-beta2`). */
  tag: string
  /** Alias of `tag` kept explicit for display. */
  version: string
  /** The release page URL to open when a newer one exists. */
  url: string
  /** ISO publish timestamp, when the API provides one. */
  publishedAt?: string
}

/** Result of `app:checkUpdate`: the installed version and a newer release, if any. */
export interface AppUpdateInfo {
  current: string
  /** The highest newer release, or `null` when already up to date. */
  latest: AppRelease | null
}

// ── GitHub API authentication (update detection) ─────────────────────────────

/** Where the effective GitHub token comes from. */
export type GithubTokenSource = 'settings' | 'env' | 'none'
/** How a saved token is protected at rest. `none` = no token saved yet. */
export type GithubEncryption = 'safe' | 'plaintext' | 'none'

/** GitHub API authentication status. Unauthenticated `api.github.com` allows
 * 60 requests/hour per IP; a token raises that to 5000. */
export interface GithubAuthState {
  /** True when a token (from settings or the environment) is in effect. */
  authenticated: boolean
  /** Where the effective token came from. */
  source: GithubTokenSource
  /** How the saved token is protected at rest. */
  encryption: GithubEncryption
  /** True when the most recent GitHub API call was rejected by the rate limiter. */
  rateLimited: boolean
}

/** Result of probing `api.github.com/rate_limit` with the current token. */
export interface GithubRateLimit {
  /** False when the request itself failed (offline / invalid token). */
  ok: boolean
  /** The authenticated login, when the token is valid. */
  login?: string
  /** Requests allowed per hour for the current auth mode. */
  limit: number
  /** Requests left in the current window. */
  remaining: number
  /** ISO timestamp when the window resets. */
  resetAt?: string
}

// ── dsh official install ─────────────────────────────────────────────────────

/** Successful official-install payload, returned to the renderer so the dialog
 * can show the installed version + paths. */
export interface DshInstallResult {
  /** Directory name under the version repo (e.g. `official`). */
  name: string
  /** Actual npm version installed (read from the installed package.json). */
  version: string
  /** Executable path (`.bin/dsh.cmd` shim). */
  execPath: string
  /** Dedicated home (`<versionRepo>/../homes/<name>`). */
  home: string
  /** Install root directory (`<versionRepo>/<name>`). */
  dir: string
}

/** Streamed per-step progress of an official dsh install, emitted from the
 * background dsh download session (see `core/pluginDownloads.ts`) and surfaced
 * through the global download center's `steps` list. Mirrors `ImportStep`:
 * resolve the version first, then `pnpm add`, then register. */
export type DshInstallStep =
  | { kind: 'version'; state: 'running' | 'ok' | 'error'; version?: string; detail?: string }
  | { kind: 'install'; state: 'running' | 'ok' | 'error'; version?: string; detail?: string }
  | { kind: 'register'; state: 'running' | 'ok' | 'error'; version?: string; detail?: string }

/** One available update track for a managed dsh. */
export interface DshUpdateTrack {
  /** The version to install (a dist-tag value: `latest` or `next`). */
  version: string
  /** Whether this track crosses a major version from the current install
   * (breaking-change warning). */
  majorBump: boolean
}

/** Update availability for a managed dsh, from `dsh:checkUpdate`. `latest` and
 * `next` are the dist-tag tracks that are newer than the current install;
 * either may be absent. At least one is present when non-`null`. */
export interface DshUpdateInfo {
  /** Currently installed version. */
  current: string
  /** Newer stable release (dist-tag `latest`), when available. */
  latest?: DshUpdateTrack
  /** Newer prerelease (dist-tag `next`), when available; distinct from `latest`. */
  next?: DshUpdateTrack
}

/** Result of a completed in-place dsh update. */
export interface DshUpdateResult {
  /** Where the home was backed up before the update. */
  backupDir: string
  /** The version actually installed. */
  version: string
}

// ── dsh data export / migration ─────────────────────────────────────────────

/** Manifest carried inside a DSH data archive (`data-manifest.json`). */
export interface DshDataManifest {
  schemaVersion: 1
  /** The dsh version the data was exported from. */
  dshVersion: string
  /** UTC export timestamp. */
  exportedAt: string
  /** Per KV-storage-domain `version` (best-effort probe; informational for the
   * cross-version warning — the Launcher never rewrites these files). */
  storageVersions: Record<string, number>
}

/** Result of importing / mirroring DSH data. */
export interface DshDataImportResult {
  ok: boolean
  text: string
  /** True when the archive's dsh major differed from the target and was refused
   * (or explicitly acknowledged via `forceDsh`). */
  dshMismatch: boolean
}

// ── npm search ──────────────────────────────────────────────────────────────

/** One hit from the npm registry search. */
export interface NpmSearchHit {
  name: string
  description: string
  version: string
  /** Author name when the registry provides one. */
  author?: string
  /** ISO publish/update timestamp of the matched version. */
  date?: string
  keywords?: string[]
}

/** A package's downloadable versions + dist-tags (for the download picker). */
export interface PackageVersionInfo {
  /** dist-tags, e.g. `{ latest: '1.2.3' }`. */
  distTags: Record<string, string>
  /** Available version strings. */
  versions: string[]
}

// ── profile instance management ─────────────────────────────────────────────

/** List summary for one profile. */
export interface ProfileSummary {
  name: string
  bundles: number
  plugins: number
  patchRows: number
  /** Whether a live runtime currently runs this profile (a delete is refused). */
  running?: boolean
}

/** Lightweight profile listing under an explicit dsh (Run page launcher) —
 * names plus manifest counts, read without touching the globally active dsh. */
export interface DshProfileInfo {
  name: string
  bundles: number
  dependencies: number
}

/** Result of a profile import — `ok` only means the profile was created. */
export interface ImportProfileResult {
  ok: boolean
  text: string
  dshMismatch: boolean
  /** bundle plugins restored into the store. */
  installed: string[]
  /** bundles that could not be downloaded (local-only, no packaged copy). */
  missing: string[]
}

/** One bundle's install origin, for display. */
export type ImportBundleSource = 'local' | 'reuse' | 'npm'

/** Streamed per-step progress of a profile import, pushed main → renderer
 * (`import:event`) so the dialog can render the steps grouped + with origin and
 * version detail: bundle installs first, then the final `pnpm install`. */
export type ImportStep =
  | { kind: 'create' }
  | {
      kind: 'bundle'
      name: string
      /** How the bundle is being fulfilled: offline pack / store reuse / npm. */
      source: ImportBundleSource
      state: 'running' | 'ok' | 'error'
      /** Resolved version once the bundle is in the store (for display). */
      version?: string
      detail?: string
    }
  | { kind: 'install'; state: 'running' | 'ok' }

// ── composed plugin lists ───────────────────────────────────────────────────

/** One composed plugin row (bundle-built, with effective disabled state). */
export interface ComboPlugin {
  /** Row id as declared by the bundle (the `- id:` value). */
  id: string
  /** Package name the row mounts (when the bundle declares one). */
  name: string
  /** Owning bundle. */
  bundle: string
  /** Effective disabled state (bundle default overridden by the user patch). */
  disabled: boolean
}

/** One store-installed plugin row (`plugins:list`). */
export interface InstalledPlugin {
  name: string
  version: string
}

// ── trash (`<home>/profiles/.trash`) ────────────────────────────────────────

/** One soft-deleted profile sitting in the trash, for `trash:list`. */
export interface TrashItem {
  name: string
  /** Manifest `dsh.profile.bundles` layer list. */
  bundles: string[]
  /** Manifest `dependencies` names. */
  deps: string[]
  /** `cordis.patch.yml` row count. */
  patchRows: number
  /** On-disk size of the directory tree, in bytes. */
  sizeBytes: number
  /** When the profile was moved to trash (ISO), derived from the dir mtime. */
  deletedAt: string
}

// ── onboarding (first-run wizard) ────────────────────────────────────────────

/** Onboarding state + the effective default directories, for `settings:getOnboardingState`. */
export interface OnboardingState {
  /** True when a fresh install should show the wizard. */
  required: boolean
  /** The current effective defaults the wizard seeds its fields with. */
  defaults: { pluginDir: string; dshVersionDir: string }
}

/** The values the wizard saves on completion, for `settings:completeOnboarding`. */
export interface OnboardingPayload {
  uiLanguage?: string
  pluginDir?: string
  dshVersionDir?: string
  /** Preferred node for launching dsh (`'system'` | `'bundled'`). */
  nodePreference?: 'system' | 'bundled'
}

// ── community market (awesome-dsh-plugin catalog) ────────────────────────────

/**
 * One plugin entry from the curated community catalog (`/plugins.json`),
 * as published by awesome-dsh-plugin and refreshed daily by its CI.
 *
 * The `null`-vs-0 rule is load-bearing: `stars`/`downloads` of `null` mean
 * "the upstream has no value" (a coverage gap), NEVER a popularity of zero —
 * sorting must treat them as unknown, not as bottom-of-the-leaderboard.
 */
export interface MarketPlugin {
  name: string
  owner: string
  /** Canonical identity key — the GitHub repo URL. Stable across renames; the
   * unique field to use when matching installed/installed names. */
  url: string
  category: string
  /** Bilingual description, keyed by locale code (`en`/`zh`…). */
  description: Record<string, string>
  /** Published npm package name, when the repo publishes one (installation
   * prefers this over a raw GitHub download). `null`/absent → GitHub-only. */
  npm?: string | null
  /** Star count as refreshed by upstream CI (not live). `null` = unknown. */
  stars?: number | null
  /** npm downloads in the last 30 days. `null` = unknown (not zero). */
  downloads?: number | null
  /** The one-line install command the catalog prints for this plugin. */
  install: string
  /** ISO date the entry was added to the catalog. */
  added?: string
  /** Catalog-side deprecation flag; when true, `replacement` names the successor. */
  deprecated?: boolean
  /** Catalog name of the suggested replacement plugin, when deprecated. */
  replacement?: string
}

/** The whole curated catalog: categories + the plugin list. */
export interface MarketCatalog {
  /** ISO date the upstream last refreshed the list. */
  updated: string
  count: number
  /** Category id → localized label, e.g. `{ ui: { en: 'UI', zh: 'UI 增强' } }`. */
  categories: Record<string, Record<string, string>>
  plugins: MarketPlugin[]
}

/** Which origin the market catalog is loaded from — a user-chosen pipeline. */
export type MarketSource = 'official' | 'custom'

/** The market's current loading route + any custom URL, for the UI picker. */
export interface MarketSourceState {
  source: MarketSource
  /** Custom `plugins.json` URL, only meaningful when `source === 'custom'`. */
  url: string
}

/** Sort orders for the market list. */
export type MarketSort = 'stars' | 'downloads' | 'newest'

/** One page of the market list, filtered + sorted + sliced in the main process.
 *
 * The market is paginated end-to-end so the first paint never pulls or renders
 * the whole catalog: `market:list` applies the query (q/category/sort), then
 * hands back `pageSize` items + a `total` to drive the pagination control. */
export interface MarketPage {
  /** ISO date the upstream last refreshed the catalog. */
  updated: string
  /** Matched plugins after the filter, BEFORE slicing — the pagination total. */
  total: number
  /** Category id → localized label, re-sent so the filter dropdown survives a reload. */
  categories: Record<string, Record<string, string>>
  /** The rows on this page. */
  items: MarketPlugin[]
  /** 1-based page actually served (clamped into [1, lastPage]). */
  page: number
  pageSize: number
}

/** Query + pagination for `market:list`. Everything except `source` narrows the
 * rows before slicing; `source` selects the loading route. */
export interface MarketListOpts {
  source?: MarketSourceState
  /** Force a network revalidation. When omitted/false, the main process serves
   * the memoized catalog for the route — so pagination, search and sort become
   * instant local slices. Pass true for a manual refresh / on a failed first load. */
  refresh?: boolean
  page?: number
  pageSize?: number
  /** Free-text search across name / owner / npm / descriptions. */
  q?: string
  /** Category id to restrict to; empty/absent = all. */
  category?: string
  sort?: MarketSort
}