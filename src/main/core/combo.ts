/**
 * A profile's composed plugin list: every plugin its bundle layers insert,
 * plus the disabled overrides from the profile's own user patch.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, homePatchPath, installAnchor, profileDir, profilesDir } from './home.ts'
import { readManifest } from './manifest.ts'
import { extractKeyValue, parseClassifiedRows, parseNamedRows, parsePatchRows } from './patch.ts'
import { child } from './logger.ts'
import type { ComboPlugin, ProfileLayer } from '../../shared/types.ts'

/** Domain-tagged logger for profile-composition work. */
const cplog = child('combo')

/** Re-export the shared composed-plugin shape. */
export type { ComboPlugin } from '../../shared/types.ts'

/** Locate a bundle package's `cordis.patch.yml`. Installation anchor comes
 * first — mirrors dsh's two-anchor resolution so in-box bundles are composed
 * from the same install the running dsh loads — then profile / shared fallback. */
export function resolveBundlePatch(bundle: string, profile: string): string | undefined {
  const anchor = installAnchor()
  const candidates = [
    ...(anchor !== undefined ? [join(anchor, 'node_modules', bundle, 'cordis.patch.yml')] : []),
    join(profileDir(profile), 'node_modules', bundle, 'cordis.patch.yml'),
    join(profilesDir(), 'node_modules', bundle, 'cordis.patch.yml'),
    join(dshHome(), 'node_modules', bundle, 'cordis.patch.yml'),
  ]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return undefined
}

/** Read the profile's user patch rows (webapp on-disk or `[]`). */
function readUserPatch(profile: string): string {
  const path = join(profileDir(profile), 'cordis.patch.yml')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/**
 * List every plugin the profile composes: its bundle rows in layer order, with
 * the effective disabled state resolved against the user patch overrides.
 */
export function listComboPlugins(profile: string): ComboPlugin[] {
  const { bundles } = readManifest(profile)
  const rows: ComboPlugin[] = []
  for (const bundle of bundles) {
    const path = resolveBundlePatch(bundle, profile)
    if (path === undefined) { cplog.debug('combo: bundle patch not found', { bundle, profile }); continue }
    for (const row of parseNamedRows(readFileSync(path, 'utf8'))) {
      rows.push({ id: row.id, name: row.name ?? '', bundle, disabled: row.disabled })
    }
  }
  const userDisabled = new Map(
    parsePatchRows(readUserPatch(profile)).map(row => [row.id, row.disabled]),
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
export function composeProfileLayers(profile: string): ProfileLayer[] {
  const layers: ProfileLayer[] = []
  const { bundles } = readManifest(profile)
  for (const bundle of bundles) {
    const patchPath = resolveBundlePatch(bundle, profile)
    if (patchPath === undefined) continue
    layers.push({
      source: 'bundle',
      bundle,
      rows: parseClassifiedRows(readFileSync(patchPath, 'utf8')),
    })
  }
  const userText = readUserPatch(profile)
  if (userText.trim() !== '') {
    layers.push({ source: 'profile', label: profile, rows: parseClassifiedRows(userText) })
  }
  const homePath = homePatchPath()
  if (existsSync(homePath)) {
    layers.push({ source: 'home', rows: parseClassifiedRows(readFileSync(homePath, 'utf8')) })
  }
  return layers
}

/** Whether a package (resolved from any node_modules root) declares `dsh.bundle`. */
function declaresBundle(pkgName: string, profile: string): boolean {
  const roots: string[] = []
  const anchor = installAnchor()
  if (anchor !== undefined) roots.push(join(anchor, 'node_modules'))
  roots.push(join(profileDir(profile), 'node_modules'))
  roots.push(join(profilesDir(), 'node_modules'))
  roots.push(join(dshHome(), 'node_modules'))
  for (const root of roots) {
    const manifestPath = join(root, pkgName, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { bundle?: unknown } }
      if (pkg.dsh?.bundle !== undefined) return true
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
export function reconcileBundles(profile: string): { added: string[]; removed: string[] } {
  const manifestPath = join(profileDir(profile), 'package.json')
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
    if (deps.includes(name) && !declaresBundle(name, profile)) {
      next.splice(next.indexOf(name), 1)
      removed.push(name)
    }
  }
  const added: string[] = []
  for (const name of deps) {
    if (!next.includes(name) && declaresBundle(name, profile)) {
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
export function defaultConfigText(profile: string, id: string): string {
  const { bundles } = readManifest(profile)
  for (const bundle of bundles) {
    const patchPath = resolveBundlePatch(bundle, profile)
    if (patchPath === undefined) continue
    const value = extractKeyValue(readFileSync(patchPath, 'utf8'), id, 'config')
    if (value !== undefined) return value
  }
  return ''
}

export function listUnclaimedBundles(profile: string): string[] {
  // Only packages actually declared as dependencies can be "installed but not
  // activated". A leftover link in node_modules with no dependency entry is a
  // prune concern, not an activation prompt — so it must not be reported.
  const { bundles, dependencies } = readManifest(profile)
  const claimed = new Set(bundles)
  return dependencies
    .filter(dep => !claimed.has(dep) && declaresBundle(dep, profile))
    .sort()
}