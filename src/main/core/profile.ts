/** Profile instance management: summaries, create, clone, soft-delete, export. */

import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { listProfiles, profileDir, profilePatchPath, profilesDir } from './home.ts'
import { pluginDir, profilesRootFor, type DshContext } from './appState.ts'
import { readManifest } from './manifest.ts'
import {
  MANIFEST_FILE_NAME, readManifestFile, readRawManifest, writeManifestFile, writeRawManifest,
} from './manifest-file.ts'
import { listComboPlugins, reconcileBundles, resolveBundlePatch } from './combo.ts'
import { appendRowBlock, assertPatchDocValid, extractRowBlock, PATCH_FILE_NAME, parsePatchRows, removeRow } from './patch.ts'
import { PNPM_WORKSPACE_YAML, runPnpm, type PnpmResult } from './pnpm.ts'
import { addLocalPlugin, addPlugin, installIntoProfile, installedStoreVersion } from './plugins.ts'
import { readVersion, versionsRoot } from './store-layout.ts'
import { pathOutsideRoot } from './name-guard.ts'
import { satisfiesRange } from './version.ts'
import { uniqueTrashName } from './trash.ts'
import { writeNewProfileId } from './launch-config.ts'
import { listBundleSubdepNames } from './bundle-subdeps.ts'
import { isReservedProfileName, PROFILE_NAME_RE, RESERVED_PROFILE_NAMES, SHIPPED_BUNDLE_NAMES } from '../../shared/profile-name.ts'
import type { ImportBundleSource, ImportProfileResult, ImportStep, ProfileBundleInfo, ProfileBundleSource, ProfileFileKind, ProfilePatchReload, ProfileSummary } from '../../shared/types.ts'
import { logger } from './logger.ts'

/** Re-export the shared profile-summary shape. */
export type { ProfileSummary } from '../../shared/types.ts'

/** Custom profiles (any name the launcher creates) use the host's default
 * patch-file lifecycle: `live`. Shipped templates are host-reserved names and
 * cannot be created here. */
const DEFAULT_PROFILE_PATCH_RELOAD: ProfilePatchReload = 'live'

/** Validate a custom profile name: kebab-case, and not a name the host reserves
 * for a shipped template (which would be normalized as that template). */
function assertCustomProfileName(name: string): void {
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

// ── raw file access (source mode) ───────────────────────────────────────────

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

// ── structured manifest edits ───────────────────────────────────────────────

/** A package name accepted as a dependency target. */
const PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i

/** Add or update one dependency and install it. A dependency that declares a
 * bundle patch is activated as a layer by the reconcile step (mirrors `dsh
 * plugin install`). */
export async function setDependency(ctx: DshContext, profile: string, pkg: string, spec: string): Promise<void> {
  if (!PACKAGE_NAME_RE.test(pkg)) throw new Error(`包名不合法：${pkg}`)
  const trimmed = spec.trim()
  if (trimmed === '') throw new Error('版本 / 来源不能为空')
  const dir = profileDir(ctx, profile)
  const manifest = readRawManifest(dir)
  manifest.dependencies = { ...(manifest.dependencies ?? {}), [pkg]: trimmed }
  writeRawManifest(dir, manifest)
  await runPnpm(dir, ['install', '--config.confirmModulesPurge=false'])
  reconcileBundles(ctx, profile)
  logger.info(`dependency set: ${profile} · ${pkg}@${trimmed}`)
}

/** Remove one dependency and prune it. */
export async function removeDependency(ctx: DshContext, profile: string, pkg: string): Promise<void> {
  const dir = profileDir(ctx, profile)
  const manifest = readRawManifest(dir)
  if (manifest.dependencies?.[pkg] === undefined) return
  delete manifest.dependencies[pkg]
  writeRawManifest(dir, manifest)
  await runPnpm(dir, ['install', '--config.confirmModulesPurge=false'])
  reconcileBundles(ctx, profile)
  logger.info(`dependency removed: ${profile} · ${pkg}`)
}

/**
 * Point a profile at a dev package dir with a live `link:` dependency. The
 * source dir is never copied — the profile resolves it directly, so edits are
 * picked up by the host (HMR). Verifies the resulting link actually resolves:
 * pnpm can report success while leaving a missing/stale link
 * (see TROUBLESHOOTING §1), so a silent success would be a lie.
 */
export async function linkDevToProfile(
  ctx: DshContext, profile: string, pkg: string, dir: string,
): Promise<{ ok: boolean; text: string }> {
  if (!PACKAGE_NAME_RE.test(pkg)) throw new Error(`包名不合法：${pkg}`)
  const target = resolve(dir)
  if (!existsSync(join(target, 'package.json'))) throw new Error(`开发包不存在：${target}`)
  await setDependency(ctx, profile, pkg, `link:${target}`)
  if (!existsSync(join(profileDir(ctx, profile), 'node_modules', pkg, 'package.json'))) {
    return { ok: false, text: `已写入 link:${target}，但 profile 的 node_modules 里没有 ${pkg}（pnpm 未重建链接，可用「重新链接」修复）` }
  }
  logger.info(`dev plugin linked: ${profile} · ${pkg} → ${target}`)
  return { ok: true, text: `已链接 ${pkg} → ${target}` }
}

/**
 * Rebuild a dev link in a profile. pnpm treats an existing-but-dangling junction
 * as installed and no-ops, so the link is dropped first (a link only — never a
 * real dir). `inSource` also installs in the dev package, repairing the
 * `@deepseek-ai/*` peers a `link:` resolves from the source side.
 */
export async function repairDevLink(
  ctx: DshContext, profile: string, pkg: string, opts: { inSource?: boolean } = {},
): Promise<{ ok: boolean; text: string }> {
  const dir = profileDir(ctx, profile)
  const spec = readRawManifest(dir).dependencies?.[pkg]
  if (spec === undefined || !spec.startsWith('link:')) throw new Error(`${pkg} 不是该 profile 的 link 依赖`)
  const source = spec.slice(5)
  const linkPath = join(dir, 'node_modules', pkg)
  try {
    if (lstatSync(linkPath).isSymbolicLink()) rmSync(linkPath, { force: true })
  } catch { /* nothing to remove */ }
  if (opts.inSource === true && existsSync(join(source, 'package.json'))) {
    await runPnpm(source, ['install', '--config.confirmModulesPurge=false'])
  }
  await runPnpm(dir, ['install', '--config.confirmModulesPurge=false'])
  const ok = existsSync(join(dir, 'node_modules', pkg, 'package.json'))
  logger.info(`dev link repair: ${profile} · ${pkg} → ${ok ? 'ok' : 'still missing'}`)
  return { ok, text: ok ? `已重新链接 ${pkg}` : `重新链接后仍未解析 ${pkg}（检查源目录的依赖）` }
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

/** Activate an already-installed package as a bundle layer: it must resolve to
 * a `dsh.bundle.patch`, and is appended to `dsh.profile.bundles`. */
export function addBundle(ctx: DshContext, profile: string, pkg: string): void {
  const dir = profileDir(ctx, profile)
  const manifest = readRawManifest(dir)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (bundles.includes(pkg)) return
  if (resolveBundlePatch(ctx, pkg, profile) === undefined) {
    throw new Error(`找不到 bundle「${pkg}」的 patch；请先在「依赖」里安装它`)
  }
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, pkg] } }
  writeRawManifest(dir, manifest)
  logger.info(`bundle activated: ${profile} · ${pkg}`)
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

/** Remove one bundle layer from a profile's `dsh.profile.bundles`, and drop its
 * dependency entry too when the profile declares it (a locally-linked bundle).
 * Then prune with `pnpm install` so any now-unreferenced link in the profile's
 * node_modules is removed — otherwise a stale link would keep showing up as an
 * "installed but unclaimed" bundle. The rest of the manifest is preserved. */
export async function removeBundle(ctx: DshContext, profile: string, bundle: string): Promise<void> {
  const manifestPath = join(profileDir(ctx, profile), MANIFEST_FILE_NAME)
  if (!existsSync(manifestPath)) throw new Error(`profile "${profile}" 不存在`)
  const manifest = readManifestFile(manifestPath) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(bundle)) throw new Error(`profile 中没有 bundle 层「${bundle}」`)
  // Capture + drop any sub-bundle `link:` deps this aggregate bundle pulled in
  // (resolved from its link spec before the dependency entry is removed), so
  // removing the layer leaves no orphaned sub-deps.
  const depSpec = manifest.dependencies?.[bundle]
  const subdeps = typeof depSpec === 'string' && (depSpec.startsWith('link:') || depSpec.startsWith('file:'))
    ? listBundleSubdepNames(depSpec.startsWith('file:') ? depSpec.slice('file:'.length) : depSpec.slice('link:'.length))
    : []
  if (manifest.dependencies !== undefined) delete manifest.dependencies[bundle]
  for (const sub of subdeps) {
    if (manifest.dependencies?.[sub] !== undefined) delete manifest.dependencies[sub]
  }
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: bundles.filter(b => b !== bundle) },
  }
  writeManifestFile(manifestPath, manifest)
  if (readManifestFile(manifestPath).dsh?.profile?.bundles?.includes(bundle)) {
    throw new Error('write verify failed: bundle still present')
  }
  // Prune the now-orphaned link from node_modules.
  await runPnpm(profileDir(ctx, profile), ['install', '--config.confirmModulesPurge=false'])
  logger.info(`profile bundle removed: ${profile} · ${bundle}`)
}

/** Move one bundle layer within `dsh.profile.bundles` to `toIndex` (0..len-1,
 * clamped). Matches drag-to-position semantics: remove then insert. */
export function reorderBundle(ctx: DshContext, profile: string, bundle: string, toIndex: number): void {
  const dir = profileDir(ctx, profile)
  const manifest = readRawManifest(dir)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const i = bundles.indexOf(bundle)
  if (i < 0) throw new Error(`profile 中没有 bundle 层「${bundle}」`)
  const clamped = Math.max(0, Math.min(toIndex, bundles.length - 1))
  const next = [...bundles]
  next.splice(i, 1)
  next.splice(clamped, 0, bundle)
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } }
  writeRawManifest(dir, manifest)
}

/** Where a profile's bundle comes from — decides how import restores it. */
export type BundleSource = 'dsh' | 'npm' | 'local'

/** One bundle layer entry with an explicit source for portable import/export. */
export interface ExportBundle {
  name: string
  /** dsh   = built-in/official, version follows the target dsh, never installed alone. */
  source: BundleSource
  /** npm-only: the version constraint to download (e.g. "^0.2.0"). */
  spec?: string
}

/** The portable, versioned profile payload for export/import (schema v2). */
export interface ProfileExport {
  schemaVersion: 2
  /** Manifest `name` (e.g. `dsh-profile-foo`). */
  name: string
  /** dsh version at export time — the source of truth for in-box bundles. */
  dshVersion: string
  bundles: ExportBundle[]
  /** Ordinary (non-bundle) npm dependencies only; never `link:`/`file:` paths. */
  dependencies: Record<string, string>
  /** `cordis.patch.yml` verbatim. */
  userPatch: string
  /** The manifest's `dsh.profile.patchReload`, when it declares one. */
  patchReload?: ProfilePatchReload
}

/** Plugin store's recorded dependency specs — the source of truth for
 * telling "downloaded from npm" apart from "installed from a local folder". */
function readStoreDeps(storeDir: string): Record<string, string> {
  if (storeDir === '') return {}
  try {
    const pkg = JSON.parse(readFileSync(join(storeDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    return pkg.dependencies ?? {}
  } catch {
    return {}
  }
}

/** Classify one bundle by where its dependency spec actually points: a
 * `link:`/`file:` into the store's `archive/` is a store-managed (npm-sourced)
 * install; any other target is the user's own local/dev plugin. A version spec
 * (e.g. `^1.4.0`) is npm. Without a dependency entry it is an in-box bundle. */
function classifyBundle(
  pkg: string,
  profileDeps: Record<string, string>,
  storeDeps: Record<string, string>,
  storeDir: string,
): ExportBundle {
  const spec = profileDeps[pkg]
  if (spec === undefined) return { name: pkg, source: 'dsh' }
  if (!spec.startsWith('link:') && !spec.startsWith('file:')) return { name: pkg, source: 'npm', spec }
  const archive = storeDir === '' ? '' : versionsRoot(storeDir)
  if (archive === '' || pathOutsideRoot(archive, spec.slice(5))) return { name: pkg, source: 'local' }
  return { name: pkg, source: 'npm', spec: storeDeps[pkg] }
}

/** Per-bundle version provenance for the profile's "replace version" UI: where
 * each layer's version comes from, plus the version actually resolved in the
 * profile's `node_modules` (best-effort — absent before a first install).
 *
 * `storeDir` is passed in rather than read from the app-state singleton, so the
 * store-anchored classification stays unit-testable. A `link:`/`file:` target
 * counts as `store` only when it sits inside the store's `archive/`; anything
 * else is the user's own local plugin. */
export function profileBundleInfo(
  ctx: DshContext, profile: string, bundles: string[], specs: Record<string, string>, storeDir: string,
): Record<string, ProfileBundleInfo> {
  const archive = storeDir === '' ? '' : versionsRoot(storeDir)
  const nodeModules = join(profileDir(ctx, profile), 'node_modules')
  const out: Record<string, ProfileBundleInfo> = {}
  for (const bundle of bundles) {
    const spec = specs[bundle]
    const version = readVersion(join(nodeModules, bundle))
    let source: ProfileBundleSource
    if (spec === undefined) source = 'dsh'
    else if (spec.startsWith('link:') || spec.startsWith('file:')) {
      source = archive !== '' && !pathOutsideRoot(archive, spec.slice(5)) ? 'store' : 'local'
    } else source = 'npm'
    out[bundle] = {
      ...(spec !== undefined ? { spec } : {}),
      ...(version !== undefined && version !== '' ? { version } : {}),
      source,
    }
  }
  return out
}

/** Leading major component of a semver (or `-1` when not parseable / empty). */
function majorOf(version: string): number {
  const m = /^(\d+)/.exec(version.trim())
  return m === null ? -1 : Number(m[1])
}

/** Export a profile as portable, versioned JSON (schema v2). Classifies each
 * bundle by source and strips `link:`/`file:` absolute paths — the file is safe
 * to move across machines. */
export function exportProfile(ctx: DshContext, name: string): string {
  const root = profilesRootFor(ctx)
  const manifest = readManifestFile(join(root, name, MANIFEST_FILE_NAME)) as {
    name?: string
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[]; patchReload?: string } }
  }
  const deps = manifest.dependencies ?? {}
  const storeDeps = readStoreDeps(pluginDir())
  const bundles: ExportBundle[] = (manifest.dsh?.profile?.bundles ?? []).map(raw => classifyBundle(String(raw), deps, storeDeps, pluginDir()))
  const bundleNames = new Set(bundles.map(b => b.name))
  const dependencies: Record<string, string> = {}
  for (const [key, spec] of Object.entries(deps)) {
    if (bundleNames.has(key) || spec.startsWith('link:') || spec.startsWith('file:')) continue
    dependencies[key] = spec
  }
  const patchPath = join(root, name, PATCH_FILE_NAME)
  const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const rawReload = manifest.dsh?.profile?.patchReload
  const patchReload = rawReload === 'live' || rawReload === 'startup' ? rawReload : undefined
  const payload: ProfileExport = {
    schemaVersion: 2,
    name: manifest.name ?? name,
    dshVersion: ctx.version,
    bundles,
    dependencies,
    userPatch: patchText,
    ...(patchReload !== undefined ? { patchReload } : {}),
  }
  return JSON.stringify(payload, null, 2)
}

/** The locally-linked bundles of a profile (their on-disk code dirs), which the
 * export dialog offers to pack into a zip. A dev link's dir is its `link:`
 * target (the source package); a store-managed `file:` dep is not local. */
export function listLocalBundles(ctx: DshContext, name: string, storeDir: string): { name: string; dir: string }[] {
  const manifest = readManifestFile(join(profilesRootFor(ctx), name, MANIFEST_FILE_NAME)) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  const profileDeps = manifest.dependencies ?? {}
  const storeDeps = readStoreDeps(storeDir)
  const out: { name: string; dir: string }[] = []
  for (const pkg of manifest.dsh?.profile?.bundles ?? []) {
    const key = String(pkg)
    if (classifyBundle(key, profileDeps, storeDeps, storeDir).source !== 'local') continue
    const spec = profileDeps[key] ?? ''
    const target = spec.startsWith('link:') || spec.startsWith('file:') ? spec.slice(5) : ''
    // A legacy flat store records a `link:` spec while the real package body
    // lives under the store's own node_modules; a dev link points at its source
    // dir directly. Prefer whichever actually holds a package.
    const recorded = storeDeps[key]
    const candidates = [
      ...(recorded !== undefined && (recorded.startsWith('link:') || recorded.startsWith('file:'))
        ? [join(storeDir, 'node_modules', key)]
        : []),
      ...(target !== '' ? [target] : []),
    ]
    const dir = candidates.find(d => existsSync(join(d, 'package.json')))
    if (dir !== undefined) out.push({ name: key, dir })
  }
  return out
}

/** Re-export the shared import-result shape. */
export type { ImportProfileResult } from '../../shared/types.ts'

/** Copy a profile (its config layers + bundle deps) from one dsh to another and
 * rebuild it under the target dsh — the cross-version profile migration path.
 *
 * The source profile is exported as schema-v2 JSON (version-tagged at its dsh),
 * its locally-linked bundles are packed into a temp dir as `localSource`, and the
 * payload is imported into the target dsh's profiles root with `forceDsh`
 * (migration is the point, so a major mismatch is not a refusal here). In-box
 * bundles (`source: dsh`) are fulfilled by the target installation itself —
 * `normalizeShippedProfile` rewrites them to the target's shipped template on its
 * next load. The source profile is left intact (`removeSource` is not offered;
 * migration is a copy). */
export async function mirrorProfile(
  source: DshContext,
  target: DshContext,
  name: string,
  opts: { forceDsh?: boolean } = {},
  onProgress?: (step: ImportStep) => void,
): Promise<ImportProfileResult> {
  const json = exportProfile(source, name)
  const storeDir = pluginDir()
  // Pack the source's locally-linked bundles into a temp dir that importProfile
  // consumes as `localSource/<name>` (mirroring the zip-export unpack layout).
  const locals = listLocalBundles(source, name, storeDir)
  let localSource = ''
  if (locals.length > 0) {
    localSource = mkdtempSync(join(tmpdir(), 'profile-mirror-'))
    for (const b of locals) cpSync(b.dir, join(localSource, b.name), { recursive: true })
  }
  try {
    return await importProfile(target, json, { name, forceDsh: opts.forceDsh ?? true, localSource }, onProgress)
  } finally {
    if (localSource !== '') rmSync(localSource, { recursive: true, force: true })
  }
}

/** Rebuild a profile in the active dsh from an exported payload. `opts.localSource`
 * is a path holding unpacked `plugins/<name>` dirs (a zip export) so local bundles
 * restore offline; otherwise they are attempted from npm and any failure lands in
 * `missing`. dsh major mismatch is refused unless `forceDsh`. */
export async function importProfile(
  ctx: DshContext,
  json: string,
  opts: { name?: string; forceDsh?: boolean; localSource?: string } = {},
  onProgress?: (step: ImportStep) => void,
): Promise<ImportProfileResult> {
  const emit: (step: ImportStep) => void = onProgress ?? (() => {})
  const data = JSON.parse(json) as Record<string, unknown>
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('导入内容不是对象')

  // dependencies (raw, may carry link: in legacy files — used for source guess).
  const rawDeps = data.dependencies
  const depsMap: Record<string, string> = {}
  if (Array.isArray(rawDeps)) {
    for (const x of rawDeps) if (typeof x === 'string') depsMap[x] = '*'
  } else if (rawDeps !== null && typeof rawDeps === 'object' && !Array.isArray(rawDeps)) {
    for (const [k, v] of Object.entries(rawDeps)) if (typeof v === 'string') depsMap[k] = v
  }

  // bundles — schema v2 structured, or legacy string[] (fit sources from depsMap).
  const rawBundles = data.bundles
  let bundles: ExportBundle[]
  if (Array.isArray(rawBundles) && rawBundles.every(b => typeof b === 'string')) {
    bundles = (rawBundles as string[]).map(pkg => {
      const spec = depsMap[pkg]
      if (spec !== undefined && spec.startsWith('link:')) return { name: pkg, source: 'local' as const }
      if (spec !== undefined) return { name: pkg, source: 'npm' as const, spec }
      return { name: pkg, source: 'dsh' as const }
    })
  } else if (Array.isArray(rawBundles)) {
    bundles = (rawBundles as { name?: unknown; source?: unknown; spec?: unknown }[])
      .filter(b => b !== null && typeof b === 'object' && typeof b.name === 'string')
      .map(b => ({
        name: b.name as string,
        source: (b.source === 'npm' || b.source === 'local' ? b.source : 'dsh') as BundleSource,
        spec: typeof b.spec === 'string' ? b.spec : undefined,
      }))
  } else {
    bundles = []
  }

  const target = (opts.name ?? (typeof data.name === 'string' ? data.name : '')).trim()
  assertCustomProfileName(target)
  const dir = join(profilesRootFor(ctx), target)
  if (existsSync(dir)) throw new Error(`profile "${target}" already exists`)

  // dsh version gate (refuse before writing anything, unless forced).
  const want = typeof data.dshVersion === 'string' ? data.dshVersion : ''
  const cur = ctx.version
  if (want !== '' && majorOf(cur) !== majorOf(want) && opts.forceDsh !== true) {
    return { ok: false, text: `该 profile 导出自 dsh ${want}，当前为 ${cur}，major 不匹配。`, dshMismatch: true, installed: [], missing: [] }
  }

  // ordinary deps (exclude bundles + any leftover link:/file: paths).
  const bundleNames = new Set(bundles.map(b => b.name))
  const deps: Record<string, string> = {}
  for (const [k, v] of Object.entries(depsMap)) {
    if (bundleNames.has(k) || v.startsWith('link:') || v.startsWith('file:')) continue
    deps[k] = v
  }
  const userPatch = typeof data.userPatch === 'string' ? data.userPatch : ''
  // A portable export may carry the manifest's patch-file lifecycle; an older
  // export (or a hand-written one) falls back to the host's custom-profile default.
  const patchReload: ProfilePatchReload = data.patchReload === 'startup' ? 'startup' : 'live'
  const storeDir = pluginDir()
  const localSource = opts.localSource ?? ''

  emit({ kind: 'create' })
  mkdirSync(dir, { recursive: true })
  writeRawManifest(dir, {
    name: `dsh-profile-${target}`,
    private: true,
    dependencies: deps,
    dsh: { profile: { bundles: bundles.map(b => b.name), patchReload } },
  })
  writeFileSync(join(dir, PATCH_FILE_NAME), userPatch || '[]')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), PNPM_WORKSPACE_YAML)
  // A freshly imported/mirrored profile is a new identity — never inherit the
  // exported profile's launch defaults.
  writeNewProfileId(dir)
  emit({ kind: 'create' })

  const installed: string[] = []
  const missing: string[] = []
  logger.debug(`profile import: ${target} (${bundles.length} bundles, ${Object.keys(deps).length} deps)`)
  for (const bundle of bundles) {
    // In-box dsh bundles need no store install — nothing to report.
    if (bundle.source === 'dsh') continue
    // 来源判定：离线打包优先，其次复用插件库（npm 需版本满足），否则从 npm 下载。
    const localDir = localSource !== '' ? join(localSource, bundle.name) : ''
    // `spec` is a *version constraint* (e.g. `0.8.0`, `^1.2.3`), never a package
    // name — install as `name@spec` so pnpm does not try to fetch a package
    // literally named "0.8.0".
    const spec = bundle.spec !== undefined && bundle.spec.trim() !== '' ? bundle.spec.trim() : undefined
    const request = spec !== undefined ? `${bundle.name}@${spec}` : bundle.name
    const offline = localDir !== '' && existsSync(localDir)
    const storeVersion = installedStoreVersion(storeDir, bundle.name)
    const canReuseStore = offline
      ? false
      : (bundle.source === 'npm'
          ? storeVersion !== undefined && satisfiesRange(storeVersion, spec ?? '')
          : storeVersion !== undefined)
    const source: ImportBundleSource = offline ? 'local' : (canReuseStore ? 'reuse' : 'npm')
    emit({ kind: 'bundle', name: bundle.name, source, state: 'running' })

    try {
      if (storeDir === '') throw new Error('未配置插件保存位置——请先在「设置」指定')
      let added: PnpmResult | null = null
      if (offline) {
        added = await addLocalPlugin(storeDir, localDir)
        if (!added.ok) throw new Error(added.text)
      } else if (!canReuseStore) {
        added = await addPlugin(storeDir, request)
        if (!added.ok) throw new Error(added.text)
      } // else：复用插件库已有的，跳过下载

      const linked = await installIntoProfile(profilesRootFor(ctx), target, bundle.name, storeDir)
      if (!linked.ok) throw new Error(linked.text)
    } catch (error) {
      missing.push(bundle.name)
      emit({ kind: 'bundle', name: bundle.name, source, state: 'error', detail: String(error) })
      continue
    }
    installed.push(bundle.name)
    emit({ kind: 'bundle', name: bundle.name, source, state: 'ok', version: installedStoreVersion(storeDir, bundle.name) })
  }

  emit({ kind: 'install', state: 'running' })
  await runPnpm(dir, ['install', '--config.confirmModulesPurge=false'])
  emit({ kind: 'install', state: 'ok' })

  const text = installed.length > 0 ? `已导入「${target}」，已入库插件 ${installed.length} 个` : `已导入「${target}」`
  logger.info(`profile imported: ${target} (installed ${installed.length}, missing ${missing.length})`)
  return { ok: true, text, dshMismatch: false, installed, missing }
}