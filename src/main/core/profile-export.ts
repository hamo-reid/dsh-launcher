/**
 * Portable profile payloads: export to versioned JSON, rebuild from one, and
 * mirror a profile from one dsh install to another.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginDir, profilesRootFor, type DshContext } from './appState.ts'
import { MANIFEST_FILE_NAME, readManifestFile, writeRawManifest } from './manifest-file.ts'
import { PATCH_FILE_NAME } from './patch.ts'
import { PNPM_WORKSPACE_YAML, runPnpm, type PnpmResult } from './pnpm.ts'
import { addLocalPlugin, addPlugin, installIntoProfile, installedStoreVersion } from './plugins.ts'
import { versionsRoot } from './store-layout.ts'
import { pathOutsideRoot } from './name-guard.ts'
import { satisfiesRange } from './version.ts'
import { writeNewProfileId } from './launch-config.ts'
import { assertCustomProfileName } from './profile-lifecycle.ts'
import type {
  ImportBundleSource, ImportProfileResult, ImportStep, ProfilePatchReload,
} from '../../shared/types.ts'
import { logger } from './logger.ts'

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
