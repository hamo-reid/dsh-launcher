/**
 * Bundle layers and dependencies inside one profile's manifest: adding and
 * removing them, reordering, dev links, and the version provenance the
 * "replace version" UI reads.
 */
import { existsSync, lstatSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { profileDir } from './home.ts'
import { MANIFEST_FILE_NAME, readManifestFile, readRawManifest, writeManifestFile, writeRawManifest } from './manifest-file.ts'
import { reconcileBundles, resolveBundlePatch } from './combo.ts'
import { runPnpm } from './pnpm.ts'
import { readVersion, versionsRoot } from './store-layout.ts'
import { pathOutsideRoot } from './name-guard.ts'
import { listBundleSubdepNames } from './bundle-subdeps.ts'
import type { DshContext } from './appState.ts'
import type { ProfileBundleInfo, ProfileBundleSource } from '../../shared/types.ts'
import { logger } from './logger.ts'

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
