/**
 * Which profiles still reference a plugin.
 *
 * Pure discovery: manifests and `lstat` only — no writes, no pnpm. The detach
 * path and the "is this plugin in use by a RUNNING profile" guards must agree on
 * this set, so the predicate lives here exactly once. Two definitions drifting
 * apart is how a guard reports "nobody uses it" while the detach moves three
 * profiles.
 *
 * A profile counts as a user when it still DECLARES the package (a dependency
 * spec, or a row in its bundle layer) or when its `node_modules` still holds an
 * entry for it. The latter matters on its own: a leftover junction whose target
 * is already gone keeps the store archive occupied on Windows, even though the
 * manifest no longer mentions it — so a "full uninstall" has to see it too.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { profilesRoot, type DshScope } from '../profile/appState.ts'
import type { ProfileManifestShape } from './layout.ts'
import type { PluginUsagePoint } from '../../../shared/types.ts'

/** One usage point plus the facts an acting caller needs to detach it. */
export interface ScannedUsage {
  /** The dsh install this usage was found under. */
  readonly scope: DshScope
  /** The profile directory, already resolved. */
  readonly dir: string
  /** The usage point exactly as it is reported to the UI. */
  readonly usage: PluginUsagePoint
  /** The manifest as the scan read it, so a rewrite acts on what was judged. */
  readonly manifest: ProfileManifestShape
  /** The declared dependency spec, when the profile still declares one. */
  readonly spec?: string
  /** Whether the profile's bundle layer lists the package. */
  readonly inBundles: boolean
  /** `lstat` of the profile's `node_modules/<pkg>`, when anything is there at
   * all — including a dangling junction, which `existsSync` reports as absent
   * yet which still pins the store archive. */
  readonly nmStat?: Stats
}

/** Whether a dependency spec points at a local directory rather than a registry
 * version. Both spellings count: `file:` is what the launcher writes, `link:`
 * is what an older install path and the dev-plugin flow write. */
export function localSpecPath(spec: string | undefined): string | undefined {
  if (spec === undefined) return undefined
  if (spec.startsWith('file:')) return spec.slice('file:'.length)
  if (spec.startsWith('link:')) return spec.slice('link:'.length)
  return undefined
}

/**
 * Every profile that still references `pkg`, with the facts needed to act on it.
 * @param dshes - The dsh installs to scan.
 * @param pkg - The plugin's npm name.
 * @param opts - `only` narrows the result by (`dsh name`, `profile name`); the
 *   first argument is the dsh NAME because that is what a usage point carries.
 * @returns One entry per referencing profile, in dsh-then-profile directory order.
 */
export function scanPluginUsages(
  dshes: DshScope[], pkg: string, opts?: { only?: (dshName: string, profile: string) => boolean },
): ScannedUsage[] {
  const found: ScannedUsage[] = []
  for (const dsh of dshes) {
    const root = profilesRoot(dsh.home)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (opts?.only !== undefined && !opts.only(dsh.name, entry.name)) continue
      const dir = join(root, entry.name)
      const manifestPath = join(dir, 'package.json')
      if (!existsSync(manifestPath)) continue
      let manifest: ProfileManifestShape
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifestShape
      } catch {
        // A profile whose manifest cannot be parsed cannot be acted on either;
        // treat it as not using the plugin rather than failing the whole scan.
        continue
      }
      const spec = manifest.dependencies?.[pkg]
      const localPath = localSpecPath(spec)
      const bundles = manifest.dsh?.profile?.bundles
      const inBundles = bundles !== undefined && bundles.includes(pkg)
      // lstat, not existsSync: a dangling junction reports absent to existsSync
      // yet still occupies the archive and still has to be unlinked.
      let nmStat: Stats | undefined
      try { nmStat = lstatSync(join(dir, 'node_modules', pkg)) } catch { /* absent */ }
      if (localPath === undefined && !inBundles && nmStat === undefined) continue
      found.push({
        scope: dsh,
        dir,
        manifest,
        inBundles,
        ...(spec !== undefined ? { spec } : {}),
        ...(nmStat !== undefined ? { nmStat } : {}),
        usage: {
          dsh: dsh.name,
          dshId: dsh.id,
          ...(dsh.version !== undefined ? { dshVersion: dsh.version } : {}),
          profile: entry.name,
          ...(spec !== undefined ? { spec } : {}),
        },
      })
    }
  }
  return found
}

/**
 * The usage points alone — the form the guards and the UI want.
 * @param dshes - The dsh installs to scan.
 * @param pkg - The plugin's npm name.
 * @param opts - Same selector as {@link scanPluginUsages}.
 * @returns One point per referencing profile.
 */
export function pluginsUsing(
  dshes: DshScope[], pkg: string, opts?: { only?: (dshName: string, profile: string) => boolean },
): PluginUsagePoint[] {
  return scanPluginUsages(dshes, pkg, opts).map(item => item.usage)
}
