/**
 * A profile instance's life: naming, listing, creating, cloning, renaming,
 * soft-deleting, and moving its patch layer to another profile.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listProfiles, profileDir, profilePatchPath, profilesDir } from './home.ts'
import { profilesRootFor, type DshContext } from './appState.ts'
import { readManifest } from './manifest.ts'
import { readRawManifest, writeRawManifest } from './manifest-file.ts'
import { listComboPlugins } from '../store/combo.ts'
import {
  appendRowBlock, assertPatchDocValid, extractRowBlock, PATCH_FILE_NAME, parsePatchRows, removeRow,
} from '../patch/patch.ts'
import { PNPM_WORKSPACE_YAML } from '../dsh/pnpm.ts'
import { uniqueTrashName } from './trash.ts'
import { writeNewProfileId } from './launch-config.ts'
import {
  isReservedProfileName, PROFILE_NAME_RE, RESERVED_PROFILE_NAMES, SHIPPED_BUNDLE_NAMES,
} from '../../../shared/profile-name.ts'
import type { ProfilePatchReload, ProfileSummary } from '../../../shared/types.ts'
import { logger } from '../shared/logger.ts'

/** Custom profiles (any name the launcher creates) use the host's default
 * patch-file lifecycle: `live`. Shipped templates are host-reserved names and
 * cannot be created here. */
const DEFAULT_PROFILE_PATCH_RELOAD: ProfilePatchReload = 'live'

/** Validate a custom profile name: kebab-case, and not a name the host reserves
 * for a shipped template (which would be normalized as that template). */
export function assertCustomProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) throw new Error('invalid profile name (use kebab-case)')
  if (isReservedProfileName(name)) {
    throw new Error(
      `profile name "${name}" is reserved by dsh's shipped templates (${RESERVED_PROFILE_NAMES.join(', ')}); choose another name`,
    )
  }
}

const PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/** List profile summaries for one dsh. */
export function listProfileSummaries(ctx: DshContext): ProfileSummary[] {
  return listProfiles(ctx).map((name) => {
    const manifest = readManifest(ctx, name)
    let plugins = 0
    try {
      plugins = listComboPlugins(ctx, name).length
    } catch {
      plugins = 0
    }
    const patchPath = profilePatchPath(ctx, name)
    const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
    return { name, bundles: manifest.bundles.length, plugins, patchRows: parsePatchRows(patchText).length }
  })
}

/** Update the manifest's display name and/or patch-file lifecycle. */
export function setManifestMeta(
  ctx: DshContext, profile: string, meta: { displayName?: string; patchReload?: ProfilePatchReload },
): void {
  const dir = profileDir(ctx, profile)
  const manifest = readRawManifest(dir)
  if (meta.displayName !== undefined) {
    const displayName = meta.displayName.trim()
    if (displayName === '') throw new Error('显示名不能为空')
    manifest.name = displayName
  }
  if (meta.patchReload !== undefined) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, patchReload: meta.patchReload } }
  }
  writeRawManifest(dir, manifest)
}

/**
 * Copy (or move) a profile's own patch layer into another profile's layer,
 * merging by row id: a target row with the same id is replaced by the source
 * row, others are appended. `move` then clears those rows from the source.
 * Both profiles may live under different dsh installs.
 */
export function transferProfilePatch(
  source: DshContext, sourceName: string, target: DshContext, targetName: string, move: boolean,
): void {
  if (source.home === target.home && sourceName === targetName) throw new Error('源与目标是同一个 profile')
  const srcPath = profilePatchPath(source, sourceName)
  const srcDir = join(profilesRootFor(source), sourceName)
  const dstDir = join(profilesRootFor(target), targetName)
  if (!existsSync(join(srcDir, 'package.json'))) throw new Error(`profile "${sourceName}" 不存在`)
  if (!existsSync(join(dstDir, 'package.json'))) throw new Error(`目标 profile "${targetName}" 不存在`)
  if (!existsSync(srcPath)) throw new Error(`profile "${sourceName}" 没有 patch 层`)

  const text = readFileSync(srcPath, 'utf8')
  const rows = parsePatchRows(text)
  if (rows.length === 0) throw new Error(`profile "${sourceName}" 的 patch 层没有行`)

  const dstPath = join(dstDir, PATCH_FILE_NAME)
  let dst = existsSync(dstPath) ? readFileSync(dstPath, 'utf8') : '[]'
  for (const row of rows) {
    const block = extractRowBlock(text, row.id)
    if (block === undefined) continue
    dst = appendRowBlock(removeRow(dst, row.id), block)
  }
  assertPatchDocValid(dst)
  writeFileSync(dstPath, dst)

  if (move) {
    let src = text
    for (const row of rows) src = removeRow(src, row.id)
    writeFileSync(srcPath, src.trim() === '' ? '[]\n' : src)
  }
  logger.info(`profile patch ${move ? 'moved' : 'copied'}: ${sourceName} → ${targetName} (${rows.length} rows)`)
}

/** Rename a profile's directory. Refuses a reserved or colliding name; keeps the
 * conventional `dsh-profile-<name>` manifest name in step. Callers must refuse a
 * profile with a live runtime (a rename would invalidate its launch). */
export function renameProfile(ctx: DshContext, oldName: string, newName: string): void {
  assertCustomProfileName(newName)
  const root = profilesRootFor(ctx)
  const src = join(root, oldName)
  const dst = join(root, newName)
  if (!existsSync(src)) throw new Error(`profile "${oldName}" not found`)
  if (existsSync(dst)) throw new Error(`profile "${newName}" already exists`)
  renameSync(src, dst)
  const manifest = readRawManifest(dst)
  if (manifest.name === `dsh-profile-${oldName}`) {
    manifest.name = `dsh-profile-${newName}`
    writeRawManifest(dst, manifest)
  }
  logger.info(`profile renamed: ${oldName} → ${newName}`)
}

/** Official profile templates offered by the "create from template" dialog. */
export const PROFILE_TEMPLATES: Record<string, string[]> = {
  base: [SHIPPED_BUNDLE_NAMES[0]],
  web: [...SHIPPED_BUNDLE_NAMES],
}

/** Create a fresh profile instance from an ordered bundle-array template. */
export function createProfile(ctx: DshContext, name: string, bundles: string[] = PROFILE_TEMPLATES.base): void {
  assertCustomProfileName(name)
  const dir = profileDir(ctx, name)
  if (existsSync(dir)) throw new Error(`profile "${name}" already exists`)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles, patchReload: DEFAULT_PROFILE_PATCH_RELOAD } },
  }
  writeRawManifest(dir, manifest)
  writeFileSync(join(dir, PATCH_FILE_NAME), PATCH_TEMPLATE)
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), PNPM_WORKSPACE_YAML)
  writeNewProfileId(dir)
  logger.info(`profile created: ${name} (${bundles.length} bundles)`)
}

/** Clone a profile's configuration (without installed node_modules). */
export function cloneProfile(ctx: DshContext, name: string, newName: string): void {
  assertCustomProfileName(newName)
  const src = profileDir(ctx, name)
  const dst = profileDir(ctx, newName)
  if (!existsSync(src)) throw new Error(`profile "${name}" not found`)
  if (existsSync(dst)) throw new Error(`profile "${newName}" already exists`)
  mkdirSync(profilesDir(ctx), { recursive: true })
  cpSync(src, dst, {
    recursive: true,
    filter: source => !source.includes('node_modules'),
  })
  // The clone is a distinct profile: give it its own id so it does not inherit
  // the source's saved launch mode/parameters.
  writeNewProfileId(dst)
  logger.info(`profile cloned: ${name} → ${newName}`)
}

/** Soft-delete: move the profile to `.trash` (never destroys the bundle layers).
 * If the trash already holds a same-named profile, the entry is auto-numbered
 * (`name (2)`, `name (3)`, …) so the delete always succeeds. */
export function softDeleteProfile(ctx: DshContext, name: string): void {
  const trash = join(profilesDir(ctx), '.trash')
  mkdirSync(trash, { recursive: true })
  const src = profileDir(ctx, name)
  if (!existsSync(src)) throw new Error(`profile "${name}" not found`)
  const dst = join(trash, uniqueTrashName(ctx, name))
  renameSync(src, dst)
  // Stamp the trash entry's mtime to the delete moment, so the trash list can
  // surface an accurate "deleted at" without an extra metadata file.
  const now = new Date()
  utimesSync(dst, now, now)
  logger.info(`profile soft-deleted: ${name}`)
}
