/** One profile's files on disk: where they are, and reading/writing them raw. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { profilePatchPath } from './home.ts'
import { profilesRootFor, type DshContext } from './appState.ts'
import { MANIFEST_FILE_NAME } from './manifest-file.ts'
import { assertPatchDocValid } from '../patch/patch.ts'
import type { ProfileFileKind } from '../../../shared/types.ts'

/** Absolute directory of one profile. */
export function profileDirPath(ctx: DshContext, name: string): string {
  return join(profilesRootFor(ctx), name)
}

/** Absolute path of one editable profile file. */
export function profileFilePath(ctx: DshContext, name: string, kind: ProfileFileKind): string {
  return kind === 'manifest'
    ? join(profilesRootFor(ctx), name, MANIFEST_FILE_NAME)
    : profilePatchPath(ctx, name)
}

/** Read a profile's raw file. `text` is `''` when it does not exist yet. */
export function readProfileFile(ctx: DshContext, name: string, kind: ProfileFileKind): { text: string; path: string } {
  const path = profileFilePath(ctx, name, kind)
  return { text: existsSync(path) ? readFileSync(path, 'utf8') : '', path }
}

/** Validate a manifest's raw JSON: structure plus the fields the host reads
 * (`dsh.profile.bundles`, `dsh.profile.patchReload`, `dependencies`). */
export function assertManifestText(text: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`package.json 不是合法 JSON：${String(error instanceof Error ? error.message : error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('package.json 顶层必须是对象')
  }
  const manifest = parsed as {
    dependencies?: unknown
    dsh?: { profile?: { bundles?: unknown; patchReload?: unknown } }
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (bundles !== undefined && (!Array.isArray(bundles) || bundles.some(b => typeof b !== 'string'))) {
    throw new Error('dsh.profile.bundles 必须是字符串数组')
  }
  const reload = manifest.dsh?.profile?.patchReload
  if (reload !== undefined && reload !== 'live' && reload !== 'startup') {
    throw new Error('dsh.profile.patchReload 必须是 "live" 或 "startup"')
  }
  const deps = manifest.dependencies
  if (deps !== undefined) {
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) {
      throw new Error('dependencies 必须是对象')
    }
    for (const [key, value] of Object.entries(deps)) {
      if (typeof value !== 'string') throw new Error(`dependencies["${key}"] 必须是字符串`)
    }
  }
}

/** Write a profile's raw file after validation, then verify the bytes landed. */
export function writeProfileFile(ctx: DshContext, name: string, kind: ProfileFileKind, text: string): void {
  if (kind === 'manifest') assertManifestText(text)
  else assertPatchDocValid(text)
  const path = profileFilePath(ctx, name, kind)
  writeFileSync(path, text)
  if (readFileSync(path, 'utf8') !== text) throw new Error('write verify failed')
}
