/** Profile instance management: summaries, create, clone, soft-delete, export. */

import {
  cpSync, existsSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { listProfiles, profileDir, profilesDir } from './home.ts'
import { readManifest } from './manifest.ts'
import { listComboPlugins } from './combo.ts'
import { parsePatchRows } from './patch.ts'
import { runPnpm, type PnpmResult } from './pnpm.ts'
import { loadSettings } from './settings.ts'
import { addLocalPlugin, addPlugin, installIntoProfile, installedStoreVersion } from './plugins.ts'
import { satisfiesRange } from './version.ts'
import { uniqueTrashName } from './trash.ts'
import type { ImportBundleSource, ImportProfileResult, ImportStep, ProfileSummary } from '../../shared/types.ts'
import { logger } from './logger.ts'

/** Re-export the shared profile-summary shape. */
export type { ProfileSummary } from '../../shared/types.ts'

const PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/** pnpm settings an out-of-tree-plugin profile needs — identical to dsh's
 * `initProfile`, so a profile created here is self-contained and shares the
 * installation's single cordis instance instead of duplicating it. */
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** List profile summaries for the active dsh. */
export function listProfileSummaries(): ProfileSummary[] {
  return listProfiles().map((name) => {
    const manifest = readManifest(name)
    let plugins = 0
    try {
      plugins = listComboPlugins(name).length
    } catch {
      plugins = 0
    }
    const patchPath = join(profileDir(name), 'cordis.patch.yml')
    const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
    return { name, bundles: manifest.bundles.length, plugins, patchRows: parsePatchRows(patchText).length }
  })
}

/** Official profile templates offered by the "create from template" dialog. */
export const PROFILE_TEMPLATES: Record<string, string[]> = {
  base: ['@deepseek-ai/dsh-base'],
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
}

/** Create a fresh profile instance from an ordered bundle-array template. */
export function createProfile(name: string, bundles: string[] = PROFILE_TEMPLATES.base): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('invalid profile name (use kebab-case)')
  const dir = profileDir(name)
  if (existsSync(dir)) throw new Error(`profile "${name}" already exists`)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles } },
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), PATCH_TEMPLATE)
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE)
  logger.info(`profile created: ${name} (${bundles.length} bundles)`)
}

/** Clone a profile's configuration (without installed node_modules). */
export function cloneProfile(name: string, newName: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(newName)) throw new Error('invalid name (use kebab-case)')
  const src = profileDir(name)
  const dst = profileDir(newName)
  if (!existsSync(src)) throw new Error(`profile "${name}" not found`)
  if (existsSync(dst)) throw new Error(`profile "${newName}" already exists`)
  mkdirSync(profilesDir(), { recursive: true })
  cpSync(src, dst, {
    recursive: true,
    filter: source => !source.includes('node_modules'),
  })
  logger.info(`profile cloned: ${name} → ${newName}`)
}

/** Soft-delete: move the profile to `.trash` (never destroys the bundle layers).
 * If the trash already holds a same-named profile, the entry is auto-numbered
 * (`name (2)`, `name (3)`, …) so the delete always succeeds. */
export function softDeleteProfile(name: string): void {
  const trash = join(profilesDir(), '.trash')
  mkdirSync(trash, { recursive: true })
  const src = profileDir(name)
  if (!existsSync(src)) throw new Error(`profile "${name}" not found`)
  const dst = join(trash, uniqueTrashName(name))
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
export async function removeBundle(profile: string, bundle: string): Promise<void> {
  const manifestPath = join(profileDir(profile), 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`profile "${profile}" 不存在`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes(bundle)) throw new Error(`profile 中没有 bundle 层「${bundle}」`)
  if (manifest.dependencies !== undefined) delete manifest.dependencies[bundle]
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: bundles.filter(b => b !== bundle) },
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  if (JSON.parse(readFileSync(manifestPath, 'utf8')).dsh?.profile?.bundles?.includes(bundle)) {
    throw new Error('write verify failed: bundle still present')
  }
  // Prune the now-orphaned link from node_modules.
  await runPnpm(profileDir(profile), ['install'])
  logger.info(`profile bundle removed: ${profile} · ${bundle}`)
}

/** Move one bundle layer within `dsh.profile.bundles` to `toIndex` (0..len-1,
 * clamped). Matches drag-to-position semantics: remove then insert. */
export function reorderBundle(profile: string, bundle: string, toIndex: number): void {
  const manifestPath = join(profileDir(profile), 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dsh?: { profile?: { bundles?: string[] } }
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const i = bundles.indexOf(bundle)
  if (i < 0) throw new Error(`profile 中没有 bundle 层「${bundle}」`)
  const clamped = Math.max(0, Math.min(toIndex, bundles.length - 1))
  const next = [...bundles]
  next.splice(i, 1)
  next.splice(clamped, 0, bundle)
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
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
}

/** The active dsh's version (from settings), or `''` when none is active. */
export function activeDshVersion(): string {
  const s = loadSettings()
  const active = s.dshes?.find(d => d.id === s.activeDshId)
  return active?.version ?? ''
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

/** Classify one bundle using BOTH the profile deps (`link:`) and the store's
 * recorded source: a `file:`/`link:` store entry means a real local plugin;
 * a version entry (e.g. `^1.4.0`) means it was downloaded from npm. Without
 * the store signal every `link:` would look local, which is wrong for npm
 * plugins that were merely installed into the profile as a link. */
function classifyBundle(
  pkg: string,
  profileDeps: Record<string, string>,
  storeDeps: Record<string, string>,
): ExportBundle {
  const spec = profileDeps[pkg]
  if (spec === undefined) return { name: pkg, source: 'dsh' }
  if (!spec.startsWith('link:') && !spec.startsWith('file:')) return { name: pkg, source: 'npm', spec }
  const stored = storeDeps[pkg]
  if (stored !== undefined && (stored.startsWith('file:') || stored.startsWith('link:'))) {
    return { name: pkg, source: 'local' }
  }
  return { name: pkg, source: 'npm', spec: stored }
}

/** Leading major component of a semver (or `-1` when not parseable / empty). */
function majorOf(version: string): number {
  const m = /^(\d+)/.exec(version.trim())
  return m === null ? -1 : Number(m[1])
}

/** Export a profile as portable, versioned JSON (schema v2). Classifies each
 * bundle by source and strips `link:`/`file:` absolute paths — the file is safe
 * to move across machines. */
export function exportProfile(name: string): string {
  const manifest = JSON.parse(readFileSync(join(profileDir(name), 'package.json'), 'utf8')) as {
    name?: string
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  const deps = manifest.dependencies ?? {}
  const storeDeps = readStoreDeps(loadSettings().pluginDir ?? '')
  const bundles: ExportBundle[] = (manifest.dsh?.profile?.bundles ?? []).map(raw => classifyBundle(String(raw), deps, storeDeps))
  const bundleNames = new Set(bundles.map(b => b.name))
  const dependencies: Record<string, string> = {}
  for (const [key, spec] of Object.entries(deps)) {
    if (bundleNames.has(key) || spec.startsWith('link:') || spec.startsWith('file:')) continue
    dependencies[key] = spec
  }
  const patchPath = join(profileDir(name), 'cordis.patch.yml')
  const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const payload: ProfileExport = {
    schemaVersion: 2,
    name: manifest.name ?? name,
    dshVersion: activeDshVersion(),
    bundles,
    dependencies,
    userPatch: patchText,
  }
  return JSON.stringify(payload, null, 2)
}

/** The locally-linked bundles of a profile (their on-disk code dirs), which the
 * export dialog offers to pack into a zip. `storeDir` is the plugin store root. */
export function listLocalBundles(name: string, storeDir: string): { name: string; dir: string }[] {
  const manifest = JSON.parse(readFileSync(join(profileDir(name), 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  const profileDeps = manifest.dependencies ?? {}
  const storeDeps = readStoreDeps(storeDir)
  const out: { name: string; dir: string }[] = []
  for (const pkg of manifest.dsh?.profile?.bundles ?? []) {
    const info = classifyBundle(String(pkg), profileDeps, storeDeps)
    if (info.source !== 'local') continue
    const dir = join(storeDir, 'node_modules', pkg)
    if (existsSync(dir)) out.push({ name: pkg, dir })
  }
  return out
}

/** Re-export the shared import-result shape. */
export type { ImportProfileResult } from '../../shared/types.ts'

/** Rebuild a profile in the active dsh from an exported payload. `opts.localSource`
 * is a path holding unpacked `plugins/<name>` dirs (a zip export) so local bundles
 * restore offline; otherwise they are attempted from npm and any failure lands in
 * `missing`. dsh major mismatch is refused unless `forceDsh`. */
export async function importProfile(
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
  if (!/^[a-z0-9][a-z0-9-]*$/.test(target)) throw new Error('invalid profile name (use kebab-case)')
  const dir = profileDir(target)
  if (existsSync(dir)) throw new Error(`profile "${target}" already exists`)

  // dsh version gate (refuse before writing anything, unless forced).
  const want = typeof data.dshVersion === 'string' ? data.dshVersion : ''
  const cur = activeDshVersion()
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
  const storeDir = loadSettings().pluginDir ?? ''
  const localSource = opts.localSource ?? ''

  emit({ kind: 'create' })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${target}`,
    private: true,
    dependencies: deps,
    dsh: { profile: { bundles: bundles.map(b => b.name) } },
  }, null, 2) + '\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), userPatch || '[]')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE)
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

      const linked = await installIntoProfile(target, bundle.name, storeDir)
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
  await runPnpm(dir, ['install'])
  emit({ kind: 'install', state: 'ok' })

  const text = installed.length > 0 ? `已导入「${target}」，已入库插件 ${installed.length} 个` : `已导入「${target}」`
  logger.info(`profile imported: ${target} (installed ${installed.length}, missing ${missing.length})`)
  return { ok: true, text, dshMismatch: false, installed, missing }
}