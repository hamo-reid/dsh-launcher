/**
 * Application-level state aggregated from persisted settings — the single
 * dependency source for the IPC layer.
 *
 * The dsh registry, effective directories and the plugin-store location all
 * live here, derived from `AppSettings` (never module globals that drift out of
 * sync). The only injected piece is the Electron `userData` path
 * (via {@link configureAppState}); `core` itself stays free of Electron imports.
 */
import { join, resolve } from 'node:path'
import { loadSettings, updateSettings, type AppSettings } from './settings.ts'
import type { DshEntry } from '../../shared/types.ts'

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

/** The profiles directory for a dsh: ALWAYS `<home>/profiles`, matching the
 * host's `$DSH_HOME/profiles`. Changing it means changing the home (which is the
 * `DSH_HOME` a direct `dsh` launch uses too), never a second path. */
export function effectiveProfileDir(entry: DshEntry): string {
  return join(entry.home, 'profiles')
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
  return join(ctx.home, 'profiles')
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

// ── directory defaults ──────────────────────────────────────────────────────

/** Default plugin store under `userData` — used until the user chooses one. */
function defaultPluginDir(): string {
  return join(userData, 'plugins')
}

/** The effective plugin store dir: the user-configured one, else the default. */
export function pluginDir(): string {
  const dir = loadSettings().pluginDir
  return typeof dir === 'string' && dir.trim() !== '' ? dir : defaultPluginDir()
}

/** Default base of the local dsh version repository. */
export function defaultVersionDir(): string {
  return join(userData, 'dsh', 'versions')
}

/** The dsh version repository location from settings (default fallback). Empty /
 * whitespace counts as unset, mirroring `pluginDir()`. */
export function dshVersionDir(): string {
  const dir = loadSettings().dshVersionDir
  return typeof dir === 'string' && dir.trim() !== '' ? dir : defaultVersionDir()
}

/** True when a genuinely fresh install should run the onboarding wizard: no
 * completion flag AND no user data yet (upgraded users with data are treated
 * as already configured — never re-surveyed). */
export function shouldRunOnboarding(): boolean {
  const s = loadSettings()
  if (s.onboarded === true) return false
  const hasUserData =
    (s.dshes?.length ?? 0) > 0 ||
    (typeof s.pluginDir === 'string' && s.pluginDir.trim() !== '') ||
    (typeof s.dshVersionDir === 'string' && s.dshVersionDir.trim() !== '')
  return !hasUserData
}

/** Convenience re-exports used by IPC modules that read/write settings. */
export type { AppSettings }