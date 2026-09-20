/**
 * A profile's composed plugin list: every plugin its bundle layers insert,
 * plus the disabled overrides from the profile's own user patch.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { dshHome, homePatchPath, installAnchor, profileDir, profilesDir } from './home.ts'
import { readManifest } from './manifest.ts'
import { assertPatchDocValid, collectInsertIds, extractKeyValue, parseClassifiedRows, parseNamedRows, parsePatchRows } from './patch.ts'
import { diagnoseMcpServers, readMcpServers } from './mcp.ts'
import { child } from './logger.ts'
import type { DshContext } from './appState.ts'
import type { ComboPlugin, InsertConflict, InsertConflictLayer, McpServer, ProfileLayer, ProfileValidation } from '../../shared/types.ts'

/** Domain-tagged logger for profile-composition work. */
const cplog = child('combo')

/** Re-export the shared composed-plugin shape. */
export type { ComboPlugin } from '../../shared/types.ts'

/** Candidate node_modules roots a bundle may be installed under, nearest first:
 * the dsh installation anchor (so in-box bundles come from the same install the
 * running dsh loads), then the profile, the shared profiles root, the dsh home.
 * Mirrors the host's install-anchor-first resolution. */
function bundleRoots(ctx: DshContext, profile: string): string[] {
  const roots: string[] = []
  const anchor = installAnchor(ctx)
  if (anchor !== undefined) roots.push(join(anchor, 'node_modules'))
  roots.push(join(profileDir(ctx, profile), 'node_modules'))
  roots.push(join(profilesDir(ctx), 'node_modules'))
  roots.push(join(dshHome(ctx), 'node_modules'))
  return roots
}

/** The patch filename a bundle package declares via `dsh.bundle.patch` — the
 * host's contract — falling back to the historical `cordis.patch.yml` for a
 * package that omits the field or cannot be read. */
function bundlePatchRel(bundleDir: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: unknown } }
    }
    const declared = manifest.dsh?.bundle?.patch
    if (typeof declared === 'string' && declared.trim() !== '') return declared
  } catch {
    // missing/invalid manifest — fall through to the default filename
  }
  return 'cordis.patch.yml'
}

/** Locate a bundle package's patch file: its declared `dsh.bundle.patch` (else
 * the `cordis.patch.yml` default), under the nearest resolvable node_modules
 * root. The host requires the declaration and fails loud without it; the
 * launcher is a viewer, so a package that omits it still resolves by filename. */
export function resolveBundlePatch(ctx: DshContext, bundle: string, profile: string): string | undefined {
  for (const root of bundleRoots(ctx, profile)) {
    const bundleDir = join(root, bundle)
    const patchPath = join(bundleDir, bundlePatchRel(bundleDir))
    if (existsSync(patchPath)) return patchPath
  }
  return undefined
}

/** Read the profile's user patch rows (webapp on-disk or `[]`). */
function readUserPatch(ctx: DshContext, profile: string): string {
  const path = join(profileDir(ctx, profile), 'cordis.patch.yml')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/**
 * List every plugin the profile composes: its bundle rows in layer order, with
 * the effective disabled state resolved against the user patch overrides.
 */
export function listComboPlugins(ctx: DshContext, profile: string): ComboPlugin[] {
  const { bundles } = readManifest(ctx, profile)
  const rows: ComboPlugin[] = []
  for (const bundle of bundles) {
    const path = resolveBundlePatch(ctx, bundle, profile)
    if (path === undefined) { cplog.debug('combo: bundle patch not found', { bundle, profile }); continue }
    for (const row of parseNamedRows(readFileSync(path, 'utf8'))) {
      rows.push({ id: row.id, name: row.name ?? '', bundle, disabled: row.disabled })
    }
  }
  const userDisabled = new Map(
    parsePatchRows(readUserPatch(ctx, profile)).map(row => [row.id, row.disabled]),
  )
  for (const row of rows) {
    const override = userDisabled.get(row.id)
    if (override !== undefined) row.disabled = override
  }
  return rows
}


/** Compose the profile's patch-layer stack in application order: each bundle
 * layer (in `dsh.profile.bundles` order), then the profile's own layer, then
 * the machine-level home layer. Used to render the layer-stack and trace which
 * source contributed (and possibly overrode) a given row id. */
export function composeProfileLayers(ctx: DshContext, profile: string): ProfileLayer[] {
  const layers: ProfileLayer[] = []
  const { bundles } = readManifest(ctx, profile)
  for (const bundle of bundles) {
    const patchPath = resolveBundlePatch(ctx, bundle, profile)
    if (patchPath === undefined) continue
    layers.push({
      source: 'bundle',
      bundle,
      rows: parseClassifiedRows(readFileSync(patchPath, 'utf8')),
    })
  }
  const userText = readUserPatch(ctx, profile)
  if (userText.trim() !== '') {
    layers.push({ source: 'profile', label: profile, rows: parseClassifiedRows(userText) })
  }
  const homePath = homePatchPath(ctx)
  if (existsSync(homePath)) {
    layers.push({ source: 'home', rows: parseClassifiedRows(readFileSync(homePath, 'utf8')) })
  }
  return layers
}

/**
 * Find loader entry ids inserted by more than one layer of a profile's composed
 * stack (bundle layers → profile → home → `--patch` overlays). The host applies
 * inserts in that order and hard-fails on a repeated id, so any entry here means
 * the profile cannot boot. A viewer-side pre-flight: it turns the host's
 * "duplicate loader entry id" stack trace into a named layer pair.
 */
export function findInsertConflicts(
  ctx: DshContext, profile: string, extraPatches: readonly string[] = [],
): InsertConflict[] {
  const layers: { source: InsertConflictLayer['source']; label?: string; bundle?: string; text: string }[] = []
  const { bundles } = readManifest(ctx, profile)
  for (const bundle of bundles) {
    const patchPath = resolveBundlePatch(ctx, bundle, profile)
    if (patchPath === undefined) continue
    layers.push({ source: 'bundle', bundle, text: readFileSync(patchPath, 'utf8') })
  }
  const userText = readUserPatch(ctx, profile)
  if (userText.trim() !== '') layers.push({ source: 'profile', label: profile, text: userText })
  const homePath = homePatchPath(ctx)
  if (existsSync(homePath)) layers.push({ source: 'home', text: readFileSync(homePath, 'utf8') })
  for (const file of extraPatches) {
    if (!existsSync(file)) continue
    layers.push({ source: 'patch', label: basename(file), text: readFileSync(file, 'utf8') })
  }

  const byId = new Map<string, InsertConflictLayer[]>()
  for (const layer of layers) {
    for (const id of collectInsertIds(layer.text)) {
      const list = byId.get(id) ?? []
      list.push({ source: layer.source, bundle: layer.bundle, label: layer.label })
      byId.set(id, list)
    }
  }
  return [...byId.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([id, list]) => ({ id, layers: list }))
}

/** Bundles listed in the manifest whose patch file cannot be resolved — the
 * profile would fail to load them at boot. */
export function listMissingBundles(ctx: DshContext, profile: string): string[] {
  const { bundles } = readManifest(ctx, profile)
  return bundles.filter(bundle => resolveBundlePatch(ctx, bundle, profile) === undefined)
}

/**
 * Pre-launch composition check for one profile: manifest/patch parse errors,
 * duplicate inserted entry ids, missing bundles and unclaimed (installed but
 * inactive) bundles. `extraPatches` are the `--patch` overlays a launch would
 * add, so the check reflects what would actually boot.
 */
export function validateComposition(
  ctx: DshContext, profile: string, extraPatches: readonly string[] = [],
): ProfileValidation {
  const result: ProfileValidation = { ok: true, conflicts: [], missingBundles: [], unclaimedBundles: [] }

  const patchPath = join(profileDir(ctx, profile), 'cordis.patch.yml')
  try {
    assertPatchDocValid(existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '[]')
  } catch (error) {
    result.patchError = error instanceof Error ? error.message : String(error)
  }

  try {
    result.missingBundles = listMissingBundles(ctx, profile)
    result.unclaimedBundles = listUnclaimedBundles(ctx, profile)
  } catch (error) {
    result.manifestError = error instanceof Error ? error.message : String(error)
  }

  // findInsertConflicts reads the manifest; skip it when that already failed.
  if (result.manifestError === undefined) result.conflicts = findInsertConflicts(ctx, profile, extraPatches)

  result.ok = result.manifestError === undefined
    && result.patchError === undefined
    && result.conflicts.length === 0
    && result.missingBundles.length === 0
  return result
}

/** Whether a package (resolved from any node_modules root) declares a
 * `dsh.bundle.patch` — the host's own bundle test (`exportsPatch`). */
function declaresBundle(ctx: DshContext, pkgName: string, profile: string): boolean {
  for (const root of bundleRoots(ctx, profile)) {
    const manifestPath = join(root, pkgName, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { bundle?: { patch?: unknown } } }
      const patch = pkg.dsh?.bundle?.patch
      if (typeof patch === 'string' && patch.trim() !== '') return true
    } catch {
      // skip unresolvable manifests
    }
  }
  return false
}

/**
 * Manually reconcile a profile's `dsh.profile.bundles` against its INSTALLED
 * state: append every declared dependency that resolves to a `dsh.bundle`
 * package, and drop every dependency-managed bundle that no longer declares
 * one. In-box template bundles are never dependencies, so they are untouched.
 * Mirrors the semantic of `dsh plugin`'s reconcile.
 */
export function reconcileBundles(ctx: DshContext, profile: string): { added: string[]; removed: string[] } {
  const manifestPath = join(profileDir(ctx, profile), 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`profile "${profile}" 不存在`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  const deps = Object.keys(manifest.dependencies ?? {})
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const next = [...bundles]
  const removed: string[] = []
  for (const name of next) {
    // Only dependency-managed bundles can be dropped; in-box template bundles
    // are not dependencies and are never touched.
    if (deps.includes(name) && !declaresBundle(ctx, name, profile)) {
      next.splice(next.indexOf(name), 1)
      removed.push(name)
    }
  }
  const added: string[] = []
  for (const name of deps) {
    if (!next.includes(name) && declaresBundle(ctx, name, profile)) {
      next.push(name)
      added.push(name)
    }
  }
  if (added.length > 0 || removed.length > 0) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }
  return { added, removed }
}

/** The `config` value a row id ships with, from the first bundle layer that
 * defines it. Empty string when no bundle declares that row's config. */
export function defaultConfigText(ctx: DshContext, profile: string, id: string): string {
  const { bundles } = readManifest(ctx, profile)
  for (const bundle of bundles) {
    const patchPath = resolveBundlePatch(ctx, bundle, profile)
    if (patchPath === undefined) continue
    const value = extractKeyValue(readFileSync(patchPath, 'utf8'), id, 'config')
    if (value !== undefined) return value
  }
  return ''
}

/**
 * Every MCP row a profile resolves, in application order, with field-level and
 * cross-row problems folded on.
 *
 * Rows are `insert:` entries, so a later layer does NOT override an earlier one
 * the way an id-targeted row does — two layers claiming one `serverName` are a
 * real dsh load failure, which {@link diagnoseMcpServers} names per row.
 */
export function listMcpServers(ctx: DshContext, profile: string): McpServer[] {
  const servers: McpServer[] = []
  const { bundles } = readManifest(ctx, profile)
  for (const bundle of bundles) {
    const patchPath = resolveBundlePatch(ctx, bundle, profile)
    if (patchPath === undefined) continue
    servers.push(...readMcpServers(readFileSync(patchPath, 'utf8'), 'bundle', bundle))
  }
  const userText = readUserPatch(ctx, profile)
  if (userText.trim() !== '') servers.push(...readMcpServers(userText, 'profile'))
  const homePath = homePatchPath(ctx)
  if (existsSync(homePath)) servers.push(...readMcpServers(readFileSync(homePath, 'utf8'), 'home'))
  return diagnoseMcpServers(servers)
}

export function listUnclaimedBundles(ctx: DshContext, profile: string): string[] {
  // Only packages actually declared as dependencies can be "installed but not
  // activated". A leftover link in node_modules with no dependency entry is a
  // prune concern, not an activation prompt — so it must not be reported.
  const { bundles, dependencies } = readManifest(ctx, profile)
  const claimed = new Set(bundles)
  return dependencies
    .filter(dep => !claimed.has(dep) && declaresBundle(ctx, dep, profile))
    .sort()
}