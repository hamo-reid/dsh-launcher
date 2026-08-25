/**
 * The plugin store's on-disk layout: where an archived version lives, how to
 * enumerate it, and the mini pnpm-project bootstrapping. Pure filesystem logic
 * with no cross-module deps, so it is the baseline other store modules build on.
 *
 * The store keeps every downloaded plugin version in its own self-contained mini
 * pnpm project under `archive/<name>/<version>/` (each holds its own package.json
 * + resolved node_modules). The same plugin can therefore hold many versions at
 * once; `installIntoProfile` links a profile to one specific version's package.
 * A per-plugin staging dir holds an in-flight download.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger.ts'
import { compareVersionsLoose } from './version.ts'

/** A profile manifest shape (bundle layers + dependencies) read by the store. */
export interface ProfileManifestShape {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] }; bundle?: { patch?: string } }
}

/** The store project's own manifest. */
export interface StoreManifest {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
}

/** Read a package.json `version` field, or `undefined`. */
export function readVersion(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }
    return pkg.version
  } catch {
    return undefined
  }
}

/** Root of the versioned plugin archive (`archive/` sub-folder of the store). */
export function versionsRoot(storeDir: string): string {
  return join(storeDir, 'archive')
}

/** Where a specific plugin lives in the versioned layout. `name` carries the
 * real npm name (`@scope/name`), so `path.join` expands a scoped package into a
 * multi-level dir — matching pnpm's nested `node_modules/@scope/name` layout, so
 * the archive path and the resolved package body always line up. */
export function pluginVersionDir(storeDir: string, name: string, version: string): string {
  return join(versionsRoot(storeDir), name, version)
}

/** The staging project a download is built into before being hoisted to its
 * version-named directory. */
export function versionStagingDir(storeDir: string, name: string): string {
  return join(versionsRoot(storeDir), name, '.staging')
}

/** Enumerate every archived plugin's real npm name. Regular packages sit directly
 * under `archive/<name>`; scoped packages start with `@` and nest one level
 * deeper as `archive/@scope/<name>`. (Legacy flattened `@scope_name` leftovers
 * read back as bogus names here, but their node_modules lookup fails below, so
 * they never surface — ignored by design.) */
export function archivedPluginNames(storeDir: string): string[] {
  const vRoot = versionsRoot(storeDir)
  if (!existsSync(vRoot)) return []
  const names: string[] = []
  for (const e of readdirSync(vRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === '.staging') continue
    if (e.name.startsWith('@')) {
      const scopeDir = join(vRoot, e.name)
      for (const s of readdirSync(scopeDir, { withFileTypes: true }))
        if (s.isDirectory() && s.name !== '.staging') names.push(`${e.name}/${s.name}`)
    } else {
      names.push(e.name)
    }
  }
  return names
}

/** Confirmed archived versions of one plugin (dirs with a resolved package). */
export function storeVersions(storeDir: string, name: string): string[] {
  const root = join(versionsRoot(storeDir), name)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== '.staging')
    .map(e => e.name)
    .filter(v => existsSync(join(root, v, 'node_modules', name, 'package.json')))
    // Semver ordering, not dictionary: `0.10.0` must rank above `0.9.5`, so
    // `latestStoreVersion` (the last entry) and any default version pick resolve
    // to the true newest release rather than the lexicographically-last string.
    .sort((a, b) => compareVersionsLoose(a, b))
}

/** Highest archived version of a plugin, or `undefined` when none is present.
 * Multi-version aware: newer versions rank above older ones by string compare. */
export function latestStoreVersion(storeDir: string, name: string): string | undefined {
  const vs = storeVersions(storeDir, name)
  return vs.length === 0 ? undefined : vs[vs.length - 1]
}

/** Version of a package currently in the store, or `undefined`. In a
 * multi-version store this reports the highest archived version, so a caller
 * checking "is an acceptable version already downloaded" keeps working. */
export function installedStoreVersion(storeDir: string, name: string): string | undefined {
  if (storeDir === '') return undefined
  return latestStoreVersion(storeDir, name) ?? readVersion(join(storeDir, 'node_modules', name))
}

/** Ensure the store directory is a pnpm project with an empty manifest. */
export function initStore(dir: string): void {
  logger.debug(`plugin store ensured: ${dir}`)
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest: StoreManifest = { name: 'plugin-store', private: true, dependencies: {} }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }
}