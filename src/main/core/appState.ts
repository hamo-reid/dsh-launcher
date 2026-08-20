/**
 * Application-level state aggregated from persisted settings — the single
 * dependency source for the IPC layer.
 *
 * dsh selection, the active install, effective directories and the plugin-store
 * location all live here, derived from `AppSettings` (never module globals that
 * drift out of sync). The only injected piece is the Electron `userData` path
 * (via {@link configureAppState}); `core` itself stays free of Electron imports.
 */
import { join } from 'node:path'
import { loadSettings, saveSettings, type AppSettings } from './settings.ts'
import type { DshEntry } from '../../shared/types.ts'

/** The dsh shape a scope carries through plugin-scoped scans. */
export interface DshScope {
  id: string
  name: string
  version?: string
  home: string
  profilesDir?: string
}

/** Electron `userData` dir, injected from the main entry before any IPC. */
let userData = ''

/** Configure app-state defaults that depend on the Electron `userData` path. */
export function configureAppState(dataDir: string): void {
  userData = dataDir
}

// ── dsh selection ───────────────────────────────────────────────────────────

/** Registered dsh installs + the active id, from settings. */
export function readDshState(): { dshes: DshEntry[]; activeDshId?: string } {
  const s = loadSettings()
  return { dshes: s.dshes ?? [], activeDshId: s.activeDshId }
}

/** Persist the registered dsh list + active id. */
export function writeDshState(dshes: DshEntry[], activeDshId?: string): void {
  saveSettings({ ...loadSettings(), dshes, activeDshId })
}

/** The active dsh entry, or `undefined` when none is selected. */
export function activeDshEntry(): DshEntry | undefined {
  const { dshes, activeDshId } = readDshState()
  return dshes.find(d => d.id === activeDshId)
}

/** The configured profiles dir for a dsh: its override, else `<home>/profiles`. */
export function effectiveProfileDir(entry: DshEntry): string {
  const dir = entry.profilesDir
  return typeof dir === 'string' && dir.trim() !== '' ? dir : join(entry.home, 'profiles')
}

/** The dsh context a profile/data operation targets — normally the active dsh,
 * but version migration / data export can target an explicit dsh. Carries just
 * the fields core functions need, so they don't depend on the full entry. */
export interface DshContext {
  home: string
  /** Override for the profiles dir (default `<home>/profiles`). */
  profilesDirOverride?: string
  /** The dsh version, for export version-tagging and cross-version gates. */
  version: string
}

/** Build a DshContext from a dsh entry. */
export function contextForEntry(entry: DshEntry): DshContext {
  return {
    home: entry.home,
    profilesDirOverride: entry.profilesDir,
    version: entry.version,
  }
}

/** The profiles root a context operates on: its override, else `<home>/profiles`. */
export function profilesRootFor(ctx: DshContext): string {
  const dir = ctx.profilesDirOverride
  return typeof dir === 'string' && dir.trim() !== '' ? dir : join(ctx.home, 'profiles')
}

/** The plugin-scan scopes derived from every registered dsh. */
export function dshScopes(): DshScope[] {
  return readDshState().dshes.map(d => ({
    id: d.id, name: d.name, version: d.version, home: d.home, profilesDir: d.profilesDir,
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

/** The dsh version repository location from settings (default fallback). */
export function dshVersionDir(): string {
  return loadSettings().dshVersionDir ?? defaultVersionDir()
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