/** Active dsh home and profile discovery. The app's current dsh decides the
 * home; switching dsh switches the whole profile/plugin view.
 *
 * The active dsh is derived from persisted settings (`activeDshId`), never a
 * mutable module global — so there is nothing to keep in sync when dsh changes. */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { resolveInstallAnchor } from './dsh.ts'
import { activeDshEntry, effectiveProfileDir } from './appState.ts'

/** The active Harness home: the current dsh's, else $DSH_HOME, else `~/.dsh`. */
export function dshHome(): string {
  return activeDshEntry()?.home ?? process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
}

/** The directory holding every profile for the active dsh: its configured
 * override if set, else `<home>/profiles`. */
export function profilesDir(): string {
  const active = activeDshEntry()
  if (active !== undefined) return effectiveProfileDir(active)
  return join(dshHome(), 'profiles')
}

/** The active dsh's install anchor (bundle resolution root), if derivable. */
export function installAnchor(): string | undefined {
  const active = activeDshEntry()
  return active === undefined ? undefined : resolveInstallAnchor(active.execPath)
}

/** The machine-level user patch layer: `$DSH_HOME/cordis.patch.yml`. Applies to
 * every profile and outranks each profile's own layer (dsh composes it after
 * the profile patch). */
export function homePatchPath(): string {
  return join(dshHome(), 'cordis.patch.yml')
}

/** One profile's directory. */
export function profileDir(name: string): string {
  return join(profilesDir(), name)
}

/** List profile names that own a manifest under the active dsh. */
export function listProfiles(): string[] {
  const dir = profilesDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, 'package.json')))
    .map(entry => entry.name)
    .sort()
}