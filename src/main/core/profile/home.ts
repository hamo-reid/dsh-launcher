/** A dsh's home and profile discovery, all keyed by an explicit {@link DshContext}.
 *
 * There is no global "active" dsh: every caller passes the dsh it targets, so a
 * profile operation can never silently act on a different install. */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveInstallAnchor } from '../dsh/dsh.ts'
import { profilesRootFor, type DshContext } from './appState.ts'
import { assertPatchDocValid, PATCH_FILE_NAME } from '../patch/patch.ts'
import { MANIFEST_FILE_NAME, readManifestFile } from './manifest-file.ts'
import type { DshProfileInfo } from '../../../shared/types.ts'

/** The dsh's home directory. */
export function dshHome(ctx: DshContext): string {
  return ctx.home
}

/** The directory holding every profile for the dsh: always `<home>/profiles`,
 * matching the host's `$DSH_HOME/profiles`. */
export function profilesDir(ctx: DshContext): string {
  return profilesRootFor(ctx)
}

/** The dsh's install anchor (bundle resolution root), if derivable. */
export function installAnchor(ctx: DshContext): string | undefined {
  return resolveInstallAnchor(ctx.execPath)
}

/** The machine-level user patch layer: `<home>/cordis.patch.yml`. Applies to
 * every profile and outranks each profile's own layer (dsh composes it after
 * the profile patch). */
export function homePatchPath(ctx: DshContext): string {
  return join(ctx.home, PATCH_FILE_NAME)
}

/** One profile's own patch layer: `<profiles>/<name>/cordis.patch.yml`. */
export function profilePatchPath(ctx: DshContext, name: string): string {
  return join(profileDir(ctx, name), PATCH_FILE_NAME)
}

/** Read the machine-level home patch layer. `text` is `''` when it does not exist. */
export function readHomePatch(ctx: DshContext): { text: string; path: string } {
  const path = homePatchPath(ctx)
  return { text: existsSync(path) ? readFileSync(path, 'utf8') : '', path }
}

/** Validate one patch layer's text and write it, then verify the result.
 *
 * The single write path for every layer the launcher owns, so a malformed
 * assembly can never reach disk and a partial write is reported rather than
 * discovered at the next launch.
 * @param path - the patch file to write.
 * @param text - the complete new document.
 */
export function writePatchFile(path: string, text: string): void {
  assertPatchDocValid(text)
  writeFileSync(path, text)
  if (readFileSync(path, 'utf8') !== text) throw new Error('write verify failed')
}

/** Write the machine-level home patch layer after YAML validation, then verify. */
export function writeHomePatch(ctx: DshContext, text: string): void {
  writePatchFile(homePatchPath(ctx), text)
}

/** Read one profile's own patch layer. `text` is `''` when it does not exist. */
export function readProfilePatch(ctx: DshContext, name: string): { text: string; path: string } {
  const path = profilePatchPath(ctx, name)
  return { text: existsSync(path) ? readFileSync(path, 'utf8') : '', path }
}

/** Write one profile's own patch layer after YAML validation, then verify. */
export function writeProfilePatch(ctx: DshContext, name: string, text: string): void {
  writePatchFile(profilePatchPath(ctx, name), text)
}

/** One profile's directory. */
export function profileDir(ctx: DshContext, name: string): string {
  return join(profilesDir(ctx), name)
}

/** List profile names that own a manifest under the dsh. */
export function listProfiles(ctx: DshContext): string[] {
  const dir = profilesDir(ctx)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, 'package.json')))
    .map(entry => entry.name)
    .sort()
}

/** Lightweight profile listing under the dsh (names + manifest counts), for the
 * Run page launcher — no active-dsh-scoped readers involved. */
export function listProfileInfos(ctx: DshContext): DshProfileInfo[] {
  const dir = profilesDir(ctx)
  if (!existsSync(dir)) return []
  const infos: DshProfileInfo[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const manifestPath = join(dir, e.name, MANIFEST_FILE_NAME)
    if (!existsSync(manifestPath)) continue
    let bundles = 0
    let dependencies = 0
    try {
      const manifest = readManifestFile(manifestPath)
      bundles = manifest.dsh?.profile?.bundles?.length ?? 0
      dependencies = Object.keys(manifest.dependencies ?? {}).length
    } catch {
      // Keep the profile listed with zero counts on a malformed manifest.
    }
    infos.push({ name: e.name, bundles, dependencies })
  }
  return infos.sort((a, b) => a.name.localeCompare(b.name))
}
