/** Active dsh home and profile discovery. The app's current dsh decides the
 * home; switching dsh switches the whole profile/plugin view.
 *
 * The active dsh is derived from persisted settings (`activeDshId`), never a
 * mutable module global — so there is nothing to keep in sync when dsh changes. */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { resolveInstallAnchor } from './dsh.ts'
import { activeDshEntry, effectiveProfileDir } from './appState.ts'
import type { DshEntry, DshProfileInfo } from '../../shared/types.ts'

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

/** List profile names under an EXPLICIT dsh, without touching the active dsh —
 * lets the Run page pick a launch target independently of the global selection.
 * Carries only manifest-derived counts, so it never needs the active-dsh-scoped
 * combo/manifest readers (the Profile page owns the richer summaries). */
export function listProfileInfosForEntry(entry: DshEntry): DshProfileInfo[] {
  const dir = effectiveProfileDir(entry)
  if (!existsSync(dir)) return []
  const infos: DshProfileInfo[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const manifestPath = join(dir, e.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    let bundles = 0
    let dependencies = 0
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        dsh?: { profile?: { bundles?: string[] } }
        dependencies?: Record<string, string>
      }
      bundles = manifest.dsh?.profile?.bundles?.length ?? 0
      dependencies = Object.keys(manifest.dependencies ?? {}).length
    } catch {
      // Keep the profile listed with zero counts on a malformed manifest.
    }
    infos.push({ name: e.name, bundles, dependencies })
  }
  return infos.sort((a, b) => a.name.localeCompare(b.name))
}