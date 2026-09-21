/**
 * Reading the store's installed-plugin picture: the flat + archived catalog, the
 * per-profile usage + version truth, README and reveal-dir lookups — the pieces
 * the "installed overview" view composes.
 */
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import {
  archivedPluginNames, latestStoreVersion, pluginVersionDir, readVersion, storeVersions, versionsRoot,
  type StoreManifest,
} from './layout.ts'
import { readPluginSources } from './sources.ts'
import { resolveInstallAnchor } from '../dsh/dsh.ts'
import { listBundleSubdepNames } from './subdeps.ts'
import { SHIPPED_BUNDLE_NAMES } from '../../../shared/profile-name.ts'
import { profilesRoot, type DshScope } from '../profile/appState.ts'
import type {
  InstalledOverviewRow, PluginKind, PluginOrigin, PluginProvenance, PluginSource,
} from '../../../shared/types.ts'

/** Management precedence, most-manageable first. */
const PROVENANCE_ORDER: readonly PluginProvenance[] = ['store', 'official', 'sub-bundle', 'local-link', 'external']

/** Derive the origin dimension from an origin-kind list. Prefers the concrete
 * sources in order npm → github → local; a built-in/untracked one maps to
 * `unknown`. Pure — unit-testable. */
export function originOf(sources: PluginSource[]): PluginOrigin {
  if (sources.includes('npm')) return 'npm'
  if (sources.includes('github')) return 'github'
  if (sources.includes('local')) return 'local'
  return 'unknown'
}

/** Classify a plugin's current role from its store/usage facts. Pure. */
export function kindOf(
  hasUsage: boolean, inStore: boolean, inBundleLayer: boolean,
): PluginKind {
  if (!inStore && hasUsage) return 'template'
  if (!hasUsage) return 'store-only'
  return inBundleLayer ? 'bundle' : 'dependency'
}

/** The single-source provenance for one usage point. Pure. */
export function provenanceOf(input: { inStore: boolean; fromAnchor: boolean; subBundle: boolean; localLink: boolean }): PluginProvenance {
  if (input.inStore) return 'store'
  if (input.fromAnchor) return 'official'
  if (input.subBundle) return 'sub-bundle'
  if (input.localLink) return 'local-link'
  return 'external'
}

/** First root under which `pkg` resolves to a real package dir. */
function findDirUnderRoots(roots: string[], pkg: string): string | undefined {
  for (const root of roots) {
    const dir = join(root, pkg)
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  return undefined
}

/** Order a set of provenances by management precedence (deduped). Pure. */
export function orderProvenances(values: Iterable<PluginProvenance>): PluginProvenance[] {
  const set = new Set(values)
  return PROVENANCE_ORDER.filter(p => set.has(p))
}

/** Whether a profile dependency spec points OUTSIDE the store archive. The
 * launcher's own managed install also uses `file:`, but targets the archive —
 * only a `link:` or a `file:` elsewhere means a locally-linked plugin. */
function depIsLocalLink(spec: string | undefined, storeDir: string): boolean {
  if (spec === undefined) return false
  if (spec.startsWith('link:')) return true
  if (!spec.startsWith('file:')) return false
  if (storeDir === '') return true
  const target = resolve(spec.slice('file:'.length))
  const archive = resolve(versionsRoot(storeDir))
  return !(target === archive || target.startsWith(archive + sep))
}

/** Read the legacy store layout (a single pnpm project at the store root). */
function legacyListPlugins(dir: string): { name: string; version: string }[] {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StoreManifest
  return Object.entries(manifest.dependencies ?? {}).map(([name, version]) => ({ name, version }))
}

/** List every archived plugin version in the store, UNION the legacy top-level
 * layout. The same plugin may appear multiple times with different versions
 * (the multi-version layout). Leftover legacy packages (still at the flat
 * `node_modules/` + manifest deps of an upgraded store) are included too, so a
 * migrated store shows nothing as missing. */
export function listPlugins(dir: string): { name: string; version: string }[] {
  if (dir === '') return [] // no store configured — never fall back to cwd
  const seen = new Set<string>()
  const out: { name: string; version: string }[] = []
  const push = (name: string, version: string): void => {
    const key = `${name}\u0000${version}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ name, version })
  }
  // Archived versions, keyed by real npm name. `storeVersions` resolves the
  // package body against `node_modules/<name>` (scoped packages nest), so only
  // versions whose resolved package is actually present count as archived.
  for (const name of archivedPluginNames(dir)) {
    for (const version of storeVersions(dir, name)) push(name, version)
  }
  for (const p of legacyListPlugins(dir)) push(p.name, p.version)
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0))
}

/** Resolve a plugin's top-level README filename (case-insensitive), if any. */
const README_NAMES = ['README.md', 'readme.md', 'README.MD', 'README', 'readme']

/** Read a plugin's README markdown, or `''` when none exists (or it is missing). */
export function readPluginReadme(dshes: DshScope[], storeDir: string, name: string): string {
  const dir = findInstalledDir(dshes, storeDir, name)
  if (dir === undefined) return ''
  for (const fileName of README_NAMES) {
    const p = join(dir, fileName)
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf8') } catch { return '' }
    }
  }
  return ''
}

/** DSH → profiles lists for the "install into a profile" picker. */
export function listProfileScopes(dshes: DshScope[]): { id: string; name: string; version?: string; profiles: string[] }[] {
  return dshes.map(dsh => {
    const dir = profilesRoot(dsh.home)
    const profiles: string[] = []
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(dir, entry.name, 'package.json'))) profiles.push(entry.name)
      }
    }
    return { id: dsh.id, name: dsh.name, version: dsh.version, profiles: profiles.sort() }
  })
}

/** Locate a plugin's on-disk install dir (store first, else the first profile
 * that uses it). Used for "reveal in file explorer". */
export function findInstalledDir(dshes: DshScope[], storeDir: string, name: string): string | undefined {
  if (storeDir !== '') {
    const v = latestStoreVersion(storeDir, name)
    if (v !== undefined) {
      const storePkg = join(pluginVersionDir(storeDir, name, v), 'node_modules', name)
      if (existsSync(join(storePkg, 'package.json'))) return storePkg
    }
    // legacy layout fallback: an upgraded store may still carry plugins at the flat
    // node_modules root (their dependencies are hoisted there — leave them in place).
    const legacy = join(storeDir, 'node_modules', name)
    if (existsSync(join(legacy, 'package.json'))) return legacy
  }
  for (const dsh of dshes) {
    const dir = profilesRoot(dsh.home)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pkg = join(dir, entry.name, 'node_modules', name)
      if (existsSync(join(pkg, 'package.json'))) return pkg
    }
  }
  return undefined
}

/**
 * Build the installed-plugin overview: the union of every plugin that is
 * actually in use across all dsh scopes' profiles (their bundle layers plus
 * installed bundle-declaring dependencies), with the store-flag and the versions
 * observed. A "downloaded but unused" store-only package stays listed too, so
 * nothing is hidden.
 */
export function buildInstalledOverview(dshes: DshScope[], storeDir: string): InstalledOverviewRow[] {
  const rows = new Map<string, InstalledOverviewRow>()
  const getRow = (name: string): InstalledOverviewRow => {
    let row = rows.get(name)
    if (row === undefined) {
      row = { name, versions: [], usage: [], inStore: false, sources: [] }
      rows.set(name, row)
    }
    return row
  }
  const noteVersion = (row: InstalledOverviewRow, version: string | undefined): void => {
    if (version !== undefined && version !== '' && !row.versions.includes(version)) row.versions.push(version)
  }
  // Names that appear in any profile's bundle *layer* — decides bundle vs plain
  // dependency in the final classification.
  const bundleLayerNames = new Set<string>()
  // Per-plugin, per-usage source signals; resolved to a provenance after the
  // store scan (a usage point's provenance depends on whether the name is in
  // the store).
  const usageFacts = new Map<string, { fromAnchor: boolean; subBundle: boolean; localLink: boolean }[]>()

  // In-use across every dsh scope.
  for (const dsh of dshes) {
    const dir = profilesRoot(dsh.home)
    if (!existsSync(dir)) continue
    // Where dsh ships its in-box bundles from (install anchor), for `official`.
    const anchor = dsh.execPath !== undefined ? resolveInstallAnchor(dsh.execPath) : undefined
    const anchorNm = anchor !== undefined ? join(anchor, 'node_modules') : undefined
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const profile = entry.name
      const manifestPath = join(dir, profile, 'package.json')
      if (!existsSync(manifestPath)) continue
      let manifest: { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch {
        continue
      }
      const bundles = manifest.dsh?.profile?.bundles ?? []
      const depSpecs = manifest.dependencies ?? {}
      const deps = Object.keys(depSpecs)
      const pkgNodeModules = join(dir, profile, 'node_modules')
      // Aggregate bundles pull in sub-packages (their patch `name:` rows) that dsh
      // must resolve from the profile; surface those too, marked `sub-bundle`.
      const bundleRoots = [
        pkgNodeModules,
        join(dir, 'node_modules'),
        join(dsh.home, 'node_modules'),
        ...(anchorNm !== undefined ? [anchorNm] : []),
      ]
      const subNames = new Set<string>()
      for (const b of bundles) {
        const bundleDir = findDirUnderRoots(bundleRoots, b)
        if (bundleDir === undefined) continue
        for (const sub of listBundleSubdepNames(bundleDir)) subNames.add(sub)
      }
      const scan: string[] = []
      for (const b of bundles) scan.push(b)
      for (const d of deps) {
        // An installed dependency that declares a bundle counts as in use too.
        if (existsSync(join(pkgNodeModules, d, 'package.json'))) scan.push(d)
      }
      // Sub-packages present locally (installed as transitive deps of an aggregate).
      for (const sub of subNames) {
        if (existsSync(join(pkgNodeModules, sub, 'package.json'))) scan.push(sub)
      }
      // Dedupe within one profile: a package may appear in both the bundle layer
      // and dependencies — that is one usage point, not two.
      const seenInProfile = new Set<string>()
      for (const name of scan) {
        if (name === 'node_modules' || seenInProfile.has(name)) continue
        seenInProfile.add(name)
        if (bundles.includes(name)) bundleLayerNames.add(name)
        // Source signals for this usage point; `inStore` is applied later.
        const fromAnchor = SHIPPED_BUNDLE_NAMES.includes(name)
          || (anchorNm !== undefined && existsSync(join(anchorNm, name, 'package.json')))
        const localLink = depIsLocalLink(depSpecs[name], storeDir)
        const subBundle = subNames.has(name)
        const facts = usageFacts.get(name)
        if (facts === undefined) usageFacts.set(name, [{ fromAnchor, subBundle, localLink }])
        else facts.push({ fromAnchor, subBundle, localLink })
        const row = getRow(name)
        // Resolve the version actually installed into this profile's
        // node_modules — the per-profile truth of "which version is applied".
        const resolved = readVersion(join(pkgNodeModules, name))
        row.usage.push({ dsh: dsh.name, dshVersion: dsh.version, profile, version: resolved })
        noteVersion(row, resolved)
      }
    }
  }

  // Store-local downloads — every archived version counts as in-store. Its
  // origin comes from the sidecar where the download recorded it; a version with
  // no record (pre-tracking store, or a hand-placed package) is a generic "store".
  if (storeDir !== '') {
    const origin = readPluginSources(storeDir)
    for (const p of listPlugins(storeDir)) {
      const row = getRow(p.name)
      row.inStore = true
      const kind = origin[`${p.name}@${p.version}`] ?? 'store'
      if (!row.sources.includes(kind)) row.sources.push(kind)
      noteVersion(row, p.version)
    }
  }

  // Finalize provenance: union each usage point's source with the store flag.
  // `provenances[0]` is the most manageable source (see `PROVENANCE_ORDER`).
  for (const row of rows.values()) {
    const set = new Set<PluginProvenance>()
    if (row.inStore) set.add('store')
    for (const fact of usageFacts.get(row.name) ?? []) {
      set.add(provenanceOf({ inStore: row.inStore, fromAnchor: fact.fromAnchor, subBundle: fact.subBundle, localLink: fact.localLink }))
    }
    row.provenances = set.size > 0 ? orderProvenances(set) : ['external']
  }

  // A package that's in use but not in the store is a dsh-bundled template
  // (e.g. @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app) — mark it as built-in,
  // not a plugin the user can manage/uninstall from the store.
  return [...rows.values()]
    .map(row => {
      const builtin = row.inStore !== true && row.usage.length > 0
      return {
        ...row,
        builtin,
        kind: kindOf(row.usage.length > 0, row.inStore === true, bundleLayerNames.has(row.name)),
        origin: originOf(row.sources),
        // A dsh-bundled template is sourced from the harness itself.
        sources: builtin && !row.sources.includes('dsh' as PluginSource) ? [...row.sources, 'dsh' as PluginSource] : row.sources,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Collect every file's `dev:ino → size` under `dir`, skipping symlink/junction
 * entries. Junction links point elsewhere (e.g. the shared pnpm store or an
 * archived sibling); their real inode is the same on-disk file and would otherwise
 * be counted once per link. Hard links share one inode, so the Map naturally
 * dedupes them.
 */
function collectDirInodes(dir: string, into: Map<string, number>): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue // junction/dir symlink — target counted where it lives
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectDirInodes(full, into)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const st = statSync(full)
      into.set(`${st.dev}:${st.ino}`, st.size)
    } catch { /* transient / locked */ }
  }
}

/** Real on-disk bytes of one directory tree — each file (by inode) counted once. */
export function dirUniqueBytes(dir: string): number {
  const inodes = new Map<string, number>()
  collectDirInodes(dir, inodes)
  let total = 0
  for (const size of inodes.values()) total += size
  return total
}

/**
 * Attach `sizeBytes` to each overview row: the plugin's own real on-disk usage,
 * merging (inode-deduped) every archived version + the legacy top-level copy
 * + (for plugins that live only in a profile, e.g. sub-bundles/builtin) that
 * profile's node_modules copy. No inode found → `sizeBytes` left undefined.
 */
export function attachPluginSizes(
  rows: InstalledOverviewRow[], dshes: DshScope[], storeDir: string,
): InstalledOverviewRow[] {
  for (const row of rows) {
    const inodes = new Map<string, number>()
    if (storeDir !== '') {
      for (const version of storeVersions(storeDir, row.name)) {
        collectDirInodes(join(pluginVersionDir(storeDir, row.name, version), 'node_modules'), inodes)
      }
      collectDirInodes(join(storeDir, 'node_modules', row.name), inodes)
    }
    if (inodes.size === 0) {
      const dir = findInstalledDir(dshes, storeDir, row.name)
      if (dir !== undefined) collectDirInodes(dir, inodes)
    }
    if (inodes.size > 0) {
      let total = 0
      for (const size of inodes.values()) total += size
      row.sizeBytes = total
    }
  }
  return rows
}