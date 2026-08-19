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

/** Input for creating/updating a row in the profile layer's patch. */
export interface RowCreateInput {
  id: string
  disabled?: boolean
  config?: string
  insert?: string[]
}

/** One point where a plugin is in use: a profile under some dsh. */
export interface PluginUsagePoint {
  dsh: string
  dshVersion?: string
  profile: string
}

/** One row of the installed-plugin overview. */
export interface InstalledOverviewRow {
  name: string
  versions: string[]
  usage: PluginUsagePoint[]
  inStore: boolean
}

/** What `profile:load` returns for one profile. */
export interface ProfileDetail {
  /** Ordered `dsh.profile.bundles` layer list. */
  bundles: string[]
  /** Profile manifest `dependencies` (package names). */
  dependencies: string[]
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
  | { ok: false; code: string; params?: Record<string, string> | string[]; error: string }

/** Streamed status of the embedded profile runtime (main → renderer via `run:event`). */
export type RunEvent =
  | { type: 'output'; line: string }
  | { type: 'exited'; code: number | null; signal: NodeJS.Signals | null; command?: string }

// ── dsh installs ────────────────────────────────────────────────────────────

/** One registered/detected dsh install. */
export interface DshEntry {
  id: string
  name: string
  execPath: string
  version: string
  /** This dsh's own data home (profiles live under `<home>/profiles`). */
  home: string
  /** Optional override for this dsh's profiles directory (default `<home>/profiles`). */
  profilesDir?: string
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

/** Streamed per-step progress of an official dsh install, pushed main → renderer
 * (`install:event`) so the dialog can render one status row per step. Mirrors
 * `ImportStep`: resolve the version first, then `pnpm add`, then register. */
export type DshInstallStep =
  | { kind: 'version'; state: 'running' | 'ok' | 'error'; version?: string; detail?: string }
  | { kind: 'install'; state: 'running' | 'ok' | 'error'; version?: string; detail?: string }
  | { kind: 'register'; state: 'running' | 'ok' | 'error'; version?: string; detail?: string }

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

// ── trash (`<profilesDir>/.trash`) ──────────────────────────────────────────

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
}