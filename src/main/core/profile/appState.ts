/**
 * Application-level state aggregated from persisted settings — the single
 * dependency source for the IPC layer.
 *
 * The dsh registry, the launcher data root and every directory derived from it
 * live here, derived from `AppSettings` (never module globals that drift out of
 * sync). The only injected piece is the Electron `userData` path
 * (via {@link configureAppState}); `core` itself stays free of Electron imports.
 */
import { join, resolve } from 'node:path'
import { loadSettings, updateSettings, type AppSettings } from '../settings/settings.ts'
import type { DshEntry } from '../../../shared/types.ts'

/** The dsh shape a scope carries through plugin-scoped scans. The profiles
 * directory is always `<home>/profiles` — the same path the host reads from
 * `$DSH_HOME/profiles` — so a scope carries no separate override. */
export interface DshScope {
  id: string
  name: string
  version?: string
  home: string
  /** The dsh executable path (for install-anchor resolution). */
  execPath?: string
}

/** Electron `userData` dir, injected from the main entry before any IPC. */
let userData = ''

/** Configure app-state defaults that depend on the Electron `userData` path. */
export function configureAppState(dataDir: string): void {
  userData = dataDir
}

// ── dsh registry ────────────────────────────────────────────────────────────

/** Registered dsh installs, from settings. There is no global "active" dsh:
 * every operation targets an explicit dsh chosen by its caller. */
export function readDshState(): { dshes: DshEntry[] } {
  return { dshes: loadSettings().dshes ?? [] }
}

/** Persist the registered dsh list. */
export function writeDshState(dshes: DshEntry[]): void {
  updateSettings((draft) => { draft.dshes = dshes })
}

/** Atomically update the registered dsh list from its CURRENT value — the safe
 * form for writers that cross an `await` and must not clobber a concurrent
 * registry change with a stale snapshot. */
export function updateDshState(mutate: (dshes: DshEntry[]) => DshEntry[]): void {
  updateSettings((draft) => { draft.dshes = mutate(draft.dshes ?? []) })
}

/** The registered dsh with this id, or `undefined`. */
export function dshEntryById(id: string | undefined): DshEntry | undefined {
  if (id === undefined || id === '') return undefined
  return readDshState().dshes.find(d => d.id === id)
}

/** The profiles directory under a dsh home: ALWAYS `<home>/profiles`, matching
 * the host's `$DSH_HOME/profiles`. This is the one definition of the segment — a
 * `DshEntry`, a `DshContext` and a `DshScope` all carry a `home`, so every caller
 * resolves it through here instead of spelling the path out. */
export function profilesRoot(home: string): string {
  return join(home, 'profiles')
}

/** The profiles directory for a dsh: ALWAYS `<home>/profiles`, matching the
 * host's `$DSH_HOME/profiles`. Changing it means changing the home (which is the
 * `DSH_HOME` a direct `dsh` launch uses too), never a second path. */
export function effectiveProfileDir(entry: DshEntry): string {
  return profilesRoot(entry.home)
}

/** The dsh context a profile/data operation targets. Carries just the fields
 * core functions need, so they don't depend on the full entry. */
export interface DshContext {
  /** The dsh executable (for install-anchor / bundle resolution). */
  execPath: string
  /** The harness home (`DSH_HOME`); profiles live at `<home>/profiles`. */
  home: string
  /** The dsh version, for export version-tagging and cross-version gates. */
  version: string
}

/** Build a DshContext from a dsh entry. */
export function contextForEntry(entry: DshEntry): DshContext {
  return { execPath: entry.execPath, home: entry.home, version: entry.version }
}

/** The profiles root a context operates on: always `<home>/profiles`. */
export function profilesRootFor(ctx: DshContext): string {
  return profilesRoot(ctx.home)
}

/** A legacy per-dsh profiles-dir override still persisted in settings. It is
 * IGNORED — profiles always live at `<home>/profiles` — but surfaced so the DSH
 * page can point the user at data that predates the fix. Returns the configured
 * path only when it differs from the canonical one. */
export function legacyProfilesDir(entry: DshEntry): string | undefined {
  const raw = (entry as { profilesDir?: unknown }).profilesDir
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const configured = resolve(raw)
  return configured === resolve(effectiveProfileDir(entry)) ? undefined : configured
}

/** The plugin-scan scopes derived from every registered dsh. */
export function dshScopes(): DshScope[] {
  return readDshState().dshes.map(d => ({
    id: d.id, name: d.name, version: d.version, home: d.home, execPath: d.execPath,
  }))
}

// ── launcher data root ──────────────────────────────────────────────────────
//
// One configured root owns the three launcher-private directories. It never
// covers profiles: those stay at `<home>/profiles`, derived from `DshContext.home`
// alone (docs/design/profile-layout.md §7). The settings database and the logs
// are not covered either — they stay under `userData`.

/** Whitespace-only counts as unset, matching the settings-store coercion. */
function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

/** The effective data root: the configured one, else the Electron `userData`
 * dir. Defaulting to `userData` is what keeps the on-disk layout identical to
 * every build that predates `dataRoot` — nothing moves unless one is set.
 * Throws when neither is available: a relative path would otherwise silently
 * resolve against the process cwd. */
export function dataRoot(): string {
  const configured = nonEmpty(loadSettings().dataRoot)
  if (configured !== undefined) return configured
  if (userData === '') throw new Error('app data root is unknown: configureAppState() has not run')
  return userData
}

/** The CONFIGURED root, or `undefined` when unset. The settings page renders
 * this rather than the effective value, so an empty field stays visibly empty
 * instead of silently adopting — and thereby persisting — the default. */
export function configuredDataRoot(): string | undefined {
  return nonEmpty(loadSettings().dataRoot)
}

/** The effective plugin store dir. A configured root owns it; otherwise the
 * pre-`dataRoot` single-dir setting; otherwise `<userData>/plugins`. */
export function pluginDir(): string {
  const s = loadSettings()
  if (nonEmpty(s.dataRoot) !== undefined) return join(dataRoot(), 'plugins')
  return nonEmpty(s.pluginDir) ?? join(userData, 'plugins')
}

/** The dsh version repository. Same precedence as {@link pluginDir}, rooted at
 * `<dataRoot>/dsh/versions` (each installed version is one subdirectory). */
export function dshVersionDir(): string {
  const s = loadSettings()
  if (nonEmpty(s.dataRoot) !== undefined) return join(dataRoot(), 'dsh', 'versions')
  return nonEmpty(s.dshVersionDir) ?? join(userData, 'dsh', 'versions')
}

/** The launcher-global skill library. It never had a single-dir setting of its
 * own, so it simply follows the root; `core/skills/library.ts` installs entries
 * from here into a dsh's own `<home>/skills`. */
export function skillLibraryDir(): string {
  return join(dataRoot(), 'skill-library')
}

/** Single-dir settings still recorded but no longer consulted because a
 * `dataRoot` is configured. Surfaced so the settings page can point the user at
 * data that is still sitting in the old location — the same "keep the field,
 * report the stale path" treatment {@link legacyProfilesDir} gives the removed
 * profiles override. Only paths that differ from the derived one are returned. */
export function legacyDirOverrides(): { key: 'pluginDir' | 'dshVersionDir'; path: string }[] {
  const s = loadSettings()
  if (nonEmpty(s.dataRoot) === undefined) return []
  const out: { key: 'pluginDir' | 'dshVersionDir'; path: string }[] = []
  const plugin = nonEmpty(s.pluginDir)
  if (plugin !== undefined && resolve(plugin) !== resolve(join(dataRoot(), 'plugins'))) {
    out.push({ key: 'pluginDir', path: plugin })
  }
  const versions = nonEmpty(s.dshVersionDir)
  if (versions !== undefined && resolve(versions) !== resolve(join(dataRoot(), 'dsh', 'versions'))) {
    out.push({ key: 'dshVersionDir', path: versions })
  }
  return out
}

/** True when a genuinely fresh install should run the onboarding wizard: no
 * completion flag AND no user data yet (upgraded users with data are treated
 * as already configured — never re-surveyed). */
export function shouldRunOnboarding(): boolean {
  const s = loadSettings()
  if (s.onboarded === true) return false
  const hasUserData =
    (s.dshes?.length ?? 0) > 0 ||
    nonEmpty(s.dataRoot) !== undefined ||
    nonEmpty(s.pluginDir) !== undefined ||
    nonEmpty(s.dshVersionDir) !== undefined
  return !hasUserData
}

/** Convenience re-exports used by IPC modules that read/write settings. */
export type { AppSettings }