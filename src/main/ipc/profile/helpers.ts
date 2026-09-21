/**
 * The profile registrar's shared pieces: input guards, the patch-layer read/write
 * pair, the composed detail read, and the two small path helpers.
 *
 * A leaf module on purpose — the five registrars all need these, and importing
 * them from the facade would make the facade and its registrars a cycle.
 */

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { profileDir, profilePatchPath } from '../../core/profile/home.ts'
import { readManifest } from '../../core/profile/manifest.ts'
import { readRawManifest } from '../../core/profile/manifest-file.ts'
import { assertPatchDocValid, parsePatchRows } from '../../core/patch/patch.ts'
import { loadStructureOnly, type StructureParse } from '../../core/patch/yaml.ts'
import { profileBundleInfo } from '../../core/profile/profile.ts'
import { pluginDir, type DshContext } from '../../core/profile/appState.ts'
import { ctxOf } from '../ctxOf.ts'
import { handle } from '../handle.ts'
import { pathIdentifierInvalid } from '../validate.ts'
import type { ProfileDetail, ProfilePatchReload } from '../../../shared/types.ts'

/** Validate a config value is a YAML mapping. Structure only, so a cordis
 * `!!js` reference (which the schema cannot resolve) is not misread as bad
 * YAML. Throws with a friendly message. */

export function assertConfigValid(configText: string): void {
  let check: StructureParse
  try {
    check = loadStructureOnly(configText)
  } catch (error) {
    throw new Error(`config 不是合法 YAML：${String(error instanceof Error ? error.message : error)}`)
  }
  if (!check.checked) return
  const parsed = check.value
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config 必须是对象（YAML 映射）')
  }
}

/** Validate an insert list reads as a YAML sequence. */
export function assertInsertValid(items: string[]): void {
  try {
    loadStructureOnly(items.map(item => `- ${item}`).join('\n'))
  } catch (error) {
    throw new Error(`insert 不是合法 YAML 列表：${String(error instanceof Error ? error.message : error)}`)
  }
}

/** Read a profile's patch layer, defaulting to an empty document. */
export function readUserPatch(ctx: DshContext, name: string): string {
  const path = profilePatchPath(ctx, name)
  return existsSync(path) ? readFileSync(path, 'utf8') : '[]'
}

export const writeUserPatch = (ctx: DshContext, name: string, next: string): void => {
  // Guard against a bad assembly ever reaching disk.
  assertPatchDocValid(next)
  const path = profilePatchPath(ctx, name)
  writeFileSync(path, next)
  if (readFileSync(path, 'utf8') !== next) throw new Error('write verify failed')
}

/** Read a profile's detail (manifest + user-patch rows). */
export function loadProfileDetail(ctx: DshContext, name: string): ProfileDetail {
  const { bundles, dependencies } = readManifest(ctx, name)
  // Read the raw manifest for the fields the manifest reader does not expose.
  let dependencySpecs: Record<string, string> = {}
  let displayName = name
  let patchReload: ProfilePatchReload = 'live'
  try {
    const raw = readRawManifest(profileDir(ctx, name))
    dependencySpecs = raw.dependencies ?? {}
    if (typeof raw.name === 'string' && raw.name !== '') displayName = raw.name
    if (raw.dsh?.profile?.patchReload === 'startup') patchReload = 'startup'
  } catch {
    // A malformed manifest still yields a detail; the source editor surfaces it.
  }
  // The raw view keeps `''` (not `[]`) for a missing layer, unlike the write path.
  const patchText = existsSync(profilePatchPath(ctx, name)) ? readFileSync(profilePatchPath(ctx, name), 'utf8') : ''
  return {
    bundles, dependencies, dependencySpecs,
    bundleInfo: profileBundleInfo(ctx, name, bundles, dependencySpecs, pluginDir()),
    displayName, patchReload, rows: parsePatchRows(patchText), patchText,
  }
}

/** A profile/bundle name from IPC must be a safe path token: it feeds
 * `profileDir(ctx, name)` / `join(profilesDir(ctx), name, …)`, so an unguarded
 * `..`, `\`, absolute path or drive prefix could read/write/rename/delete
 * OUTSIDE the profiles tree. Mirrors the guard `plugins`/`trash` apply. */
export function invalidName(name: unknown): boolean {
  return typeof name !== 'string' || pathIdentifierInvalid(name)
}

/** Where the zip-import flow may leave unpacked data for cleanup. */
export function importTmpRoot(): string {
  return join(app.getPath('userData'), 'import-tmp')
}
