/**
 * A profile's composed plugin list: every plugin its bundle layers insert,
 * plus the disabled overrides from the profile's own user patch.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homePatchPath, profileDir, profilePatchPath } from '../profile/home.ts'
import { readManifest } from '../profile/manifest.ts'
import { moduleSearchRoots } from './module-resolve.ts'
import { bundlePatchRels, declaredBundlePatches } from './bundle-manifest.ts'
import {
  assertPatchDocValid, collectInsertIds, extractKeyValue, parseClassifiedRows, parseNamedRows,
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

/** A profile's resolved search roots. Callers that resolve MANY bundles — every
 * loop below — should build this once and pass it down: building it walks the
 * install anchor and compiles a Node lookup chain, so rebuilding it per bundle is
 * the difference between one walk and N. */
type SearchRoots = readonly { dir: string }[]

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
export function resolveBundlePatches(
  ctx: DshContext, bundle: string, profile: string, roots?: SearchRoots,
): string[] {
  for (const { dir } of roots ?? moduleSearchRoots(ctx, profile)) {
    const bundleDir = join(dir, bundle)
    if (!existsSync(bundleDir)) continue
    const found = bundlePatchRels(bundleDir)
      .map(rel => join(bundleDir, rel))
      .filter(path => existsSync(path))
    if (found.length > 0) return found
  }
  return []
}

/**
 * The FIRST patch file of a bundle, or undefined when none resolves.
 *
 * Callers that read a bundle's rows want {@link resolveBundlePatches}: since
 * 0.2.0-rc.1 a bundle may declare several patch files, and a bundle's later ones
 * (the four `presets/*.patch.yml` of `dsh-web-app`) carry whole entry sets that
 * this single-file view never sees.
 */
export function resolveBundlePatch(
  ctx: DshContext, bundle: string, profile: string, roots?: SearchRoots,
): string | undefined {
  return resolveBundlePatches(ctx, bundle, profile, roots)[0]
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
  const roots = moduleSearchRoots(ctx, profile)
  const rows: ComboPlugin[] = []
  for (const bundle of bundles) {
    const paths = resolveBundlePatches(ctx, bundle, profile, roots)
    if (paths.length === 0) { cplog.debug('combo: bundle patch not found', { bundle, profile }); continue }
    for (const path of paths) {
      for (const row of parseNamedRows(readFileSync(path, 'utf8'))) {
        rows.push({ id: row.id, name: row.name ?? '', bundle, disabled: row.disabled })
      }
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


/** One patch layer's raw text, in application order. */
export interface LayerText {
  source: ProfileLayer['source']
  bundle?: string
  /** Absolute path of the layer's patch file. */
  path: string
  text: string
}

/**
 * Each patch layer's TEXT, in application order: every resolved bundle layer (in
 * `dsh.profile.bundles` order), then the profile's own layer, then the
 * machine-level home layer.
 *
 * The walk {@link composeProfileLayers} classifies, unclassified. A second walk
 * would be a second answer to "which layers are there", and a reader that needs
 * raw text — the preset declaration fold slices a declaration's `plugins:` block
 * verbatim out of it — must not be able to disagree with the layer-stack view.
 * @param ctx - the dsh to read.
 * @param profile - the profile whose stack is composed.
 * @returns one entry per layer that exists, in the order dsh applies them.
 */
export function composeLayerTexts(ctx: DshContext, profile: string): LayerText[] {
  const layers: LayerText[] = []
  const { bundles } = readManifest(ctx, profile)
  const roots = moduleSearchRoots(ctx, profile)
  for (const bundle of bundles) {
    for (const patchPath of resolveBundlePatches(ctx, bundle, profile, roots)) {
      layers.push({ source: 'bundle', bundle, path: patchPath, text: readFileSync(patchPath, 'utf8') })
    }
  }
  const userText = readUserPatch(ctx, profile)
  if (userText.trim() !== '') {
    layers.push({ source: 'profile', path: profilePatchPath(ctx, profile), text: userText })
  }
  const homePath = homePatchPath(ctx)
  if (existsSync(homePath)) {
    layers.push({ source: 'home', path: homePath, text: readFileSync(homePath, 'utf8') })
  }
  return layers
}

/** Compose a profile's patch-layer stack in application order: each bundle
 * layer (in `dsh.profile.bundles` order), then the profile's own layer, then
 * the machine-level home layer. Used to render the layer-stack and trace which
 * source contributed (and possibly overrode) a given row id. */
export function composeProfileLayers(ctx: DshContext, profile: string): ProfileLayer[] {
  return composeLayerTexts(ctx, profile).map(layer => ({
    source: layer.source,
    ...(layer.bundle === undefined ? {} : { bundle: layer.bundle }),
    ...(layer.source === 'profile' ? { label: profile } : {}),
    rows: parseClassifiedRows(layer.text),
  }))
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
  const roots = moduleSearchRoots(ctx, profile)
  for (const bundle of bundles) {
    for (const patchPath of resolveBundlePatches(ctx, bundle, profile, roots)) {
      layers.push({ source: 'bundle', bundle, text: readFileSync(patchPath, 'utf8') })
    }
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

/** Whether every patch file a bundle declares resolves.
 *
 * A bundle that is absent entirely, or missing one of its declared patch files,
 * is skipped whole at boot — the host drops the bundle LAYER, so its rows never
 * compose. "Resolvable" therefore means all of them, not the first one.
 */
function bundlePatchesResolve(
  ctx: DshContext, bundle: string, profile: string, roots?: SearchRoots,
): boolean {
  for (const { dir } of roots ?? moduleSearchRoots(ctx, profile)) {
    const bundleDir = join(dir, bundle)
    if (!existsSync(bundleDir)) continue
    return bundlePatchRels(bundleDir).every(rel => existsSync(join(bundleDir, rel)))
  }
  return false
}

/** Bundles listed in the manifest whose patch files cannot all be resolved — the
 * profile would fail to load them at boot. */
export function listMissingBundles(ctx: DshContext, profile: string): string[] {
  const { bundles } = readManifest(ctx, profile)
  const roots = moduleSearchRoots(ctx, profile)
  return bundles.filter(bundle => !bundlePatchesResolve(ctx, bundle, profile, roots))
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
function declaresBundle(ctx: DshContext, pkgName: string, profile: string, roots?: SearchRoots): boolean {
  for (const { dir } of roots ?? moduleSearchRoots(ctx, profile)) {
    if (declaredBundlePatches(join(dir, pkgName)).length > 0) return true
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
  const roots = moduleSearchRoots(ctx, profile)
  const next = [...bundles]
  const removed: string[] = []
  for (const name of next) {
    // Only dependency-managed bundles can be dropped; in-box template bundles
    // are not dependencies and are never touched.
    if (deps.includes(name) && !declaresBundle(ctx, name, profile, roots)) {
      next.splice(next.indexOf(name), 1)
      removed.push(name)
    }
  }
  const added: string[] = []
  for (const name of deps) {
    if (!next.includes(name) && declaresBundle(ctx, name, profile, roots)) {
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
  const roots = moduleSearchRoots(ctx, profile)
  for (const bundle of bundles) {
    for (const patchPath of resolveBundlePatches(ctx, bundle, profile, roots)) {
      const value = extractKeyValue(readFileSync(patchPath, 'utf8'), id, 'config')
      if (value !== undefined) return value
    }
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
  const roots = moduleSearchRoots(ctx, profile)
  for (const bundle of bundles) {
    for (const patchPath of resolveBundlePatches(ctx, bundle, profile, roots)) {
      servers.push(...readMcpServers(readFileSync(patchPath, 'utf8'), 'bundle', bundle))
    }
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
  const roots = moduleSearchRoots(ctx, profile)
  return dependencies
    .filter(dep => !claimed.has(dep) && declaresBundle(ctx, dep, profile, roots))
    .sort()
}