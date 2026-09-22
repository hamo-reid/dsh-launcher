/**
 * A profile's composed plugin list: every plugin its bundle layers insert,
 * plus the disabled overrides from the profile's own user patch.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homePatchPath, profileDir, profilePatchPath } from '../profile/home.ts'
import { readManifest } from '../profile/manifest.ts'
import { moduleSearchRoots } from './module-resolve.ts'
import {
  assertPatchDocValid, collectInsertIds, extractKeyValue, PATCH_FILE_NAME, parseClassifiedRows, parseNamedRows,
  parsePatchRows,
} from '../patch/patch.ts'
import { diagnoseMcpServers, readMcpServers } from '../mcp/mcp.ts'
import { child } from '../shared/logger.ts'
import type { DshContext } from '../profile/appState.ts'
import type {
  ComboPlugin, InsertConflict, InsertConflictLayer, McpServer, ProfileLayer, ProfileValidation,
} from '../../../shared/types.ts'

/** Domain-tagged logger for profile-composition work. */
const cplog = child('combo')

/** Re-export the shared composed-plugin shape. */
export type { ComboPlugin } from '../../../shared/types.ts'

/** The patch filename a bundle package declares via `dsh.bundle.patch`, or
 * `undefined` when it declares none (or its manifest is unreadable). Both bundle
 * judgements read through here: {@link bundlePatchRel} turns the result into a
 * filename, {@link declaresBundle} treats "declared at all" as the host's own
 * bundle test. */
function declaredBundlePatch(pkgDir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: unknown } }
    }
    const declared = manifest.dsh?.bundle?.patch
    if (typeof declared === 'string' && declared.trim() !== '') return declared
  } catch {
    // missing/invalid manifest — not a declaration
  }
  return undefined
}

/** The filename to look for inside a bundle dir: the declared `dsh.bundle.patch`,
 * else the historical `cordis.patch.yml`. The host requires the declaration and
 * fails loud without it; the launcher is a viewer, so a package that omits it
 * still resolves by filename. */
function bundlePatchRel(bundleDir: string): string {
  return declaredBundlePatch(bundleDir) ?? PATCH_FILE_NAME
}

/**
 * Locate a bundle package's patch file: its declared `dsh.bundle.patch` (else the
 * `cordis.patch.yml` default), under the nearest directory `moduleSearchRoots`
 * offers. The host requires the declaration and fails loud without it; the
 * launcher is a viewer, so a package that omits it still resolves by filename.
 *
 * The candidate LIST is the point. On a pnpm install the anchor's
 * `node_modules/@deepseek-ai/` holds only `dsh`, and every other bundle the
 * manifest names is a transitive dependency of it, living under
 * `.pnpm/<pkg>@<ver>_<hash>/node_modules` — so a plain root+name probe reports
 * every official bundle as missing, and (through {@link declaresBundle}) lets
 * `reconcileBundles` drop them from `dsh.profile.bundles`.
 *
 * Each candidate is judged by its PATCH file, never by `package.json`: a bundle
 * tree may ship only the patch, and the host's contract is the patch itself. A
 * dangling candidate is skipped rather than returned, so the result is always
 * readable.
 */
export function resolveBundlePatch(ctx: DshContext, bundle: string, profile: string): string | undefined {
  for (const { dir } of moduleSearchRoots(ctx, profile)) {
    const bundleDir = join(dir, bundle)
    if (!existsSync(bundleDir)) continue
    const patchPath = join(bundleDir, bundlePatchRel(bundleDir))
    if (existsSync(patchPath)) return patchPath
  }
  return undefined
}

/** Read the profile's user patch rows (webapp on-disk or `[]`). */
function readUserPatch(ctx: DshContext, profile: string): string {
  const path = profilePatchPath(ctx, profile)
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

  const patchPath = profilePatchPath(ctx, profile)
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

/**
 * Whether a package (from any `moduleSearchRoots` directory) declares a
 * `dsh.bundle.patch` — the host's own bundle test (`exportsPatch`).
 *
 * `resolveBundlePatch` asks that same chain for a FILE; this asks for a
 * DECLARATION. A package that declares a patch but whose patch cannot be resolved
 * is still a bundle, so the two judgements must not be conflated —
 * `reconcileBundles` drops a layer on this one alone.
 */
function declaresBundle(ctx: DshContext, pkgName: string, profile: string): boolean {
  for (const { dir } of moduleSearchRoots(ctx, profile)) {
    if (declaredBundlePatch(join(dir, pkgName)) !== undefined) return true
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