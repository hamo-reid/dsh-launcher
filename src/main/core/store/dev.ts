/**
 * Local development plugins.
 *
 * A dev plugin is a package DIRECTORY linked (`link:<dir>`) into a profile
 * instead of being copied into the plugin store, so edits are picked up live
 * (dsh's HMR — `--expose-internals` is always passed — does the reloading). The
 * launcher keeps its own registry (settings `prefs.devPlugins`) so dev plugins
 * are managed separately from the store: never update-checked, version-managed
 * or removed with it, and never deleted from disk.
 *
 * Resolution is driven by the ACTUAL patch, not by directory structure: a dev
 * bundle's `dsh.bundle.patch` rows name the modules dsh loads, and each is
 * resolved from the bundle anchor the same way the host resolves it. A pnpm
 * monorepo therefore needs no whole-workspace scan — only what the patch really
 * references. `@deepseek-ai/*` peers are a second, independent axis: a `link:`
 * resolves them from the DEV package (not the profile), so they may need a
 * shim/`pnpm install` (see `diagnoseDevPlugin`).
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadSettings, updateSettings } from '../settings/settings.ts'
import { parseNamedRows } from '../patch/patch.ts'
import {
  bindingFor, forgetModuleIndex, moduleIndexFor, packageOf, resolveModule, type ResolvedModule,
} from './module-index.ts'
import { runPnpm } from '../dsh/pnpm.ts'
import { createKeyedCache } from '../shared/keyed-cache.ts'
import { logger } from '../shared/logger.ts'
import type { DshContext } from '../profile/appState.ts'
import type {
  DevBuildTarget, DevDiagnosis, DevPatchRow, DevPeer, DevPlugin, DevRunResult, DevScriptOptions,
} from '../../../shared/types.ts'



/** The manifest fields the dev-plugin helpers read. */
interface DevManifest {
  name?: string
  version?: string
  main?: string
  exports?: unknown
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

/** Bare specifiers imported by built code: `from 'x'`, `import 'x'`,
 * `require('x')`. The scope is deliberately open — the host's tree also holds
 * unscoped packages, and a name's usefulness is decided by the index, not by its
 * spelling. */
const IMPORT_SPEC_RE = /(?:\bfrom\s*|\bimport\s*|\brequire\(\s*)['"]([^'"]+)['"]/g

/** Whether a spec is something other than a package: relative/absolute paths,
 * `node:` builtins, URLs, and pnpm's virtual-store paths. */
function notAPackage(spec: string): boolean {
  return spec === '' || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') ||
    spec.startsWith('data:') || spec.includes('://') || spec.startsWith('\\')
}

function readManifest(dir: string): DevManifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as DevManifest
}

/** The package's entry file (relative), from `exports` then `main`. */
function entryRel(m: DevManifest): string | undefined {
  const ex = m.exports
  if (typeof ex === 'string') return ex
  if (ex !== null && typeof ex === 'object') {
    const dot = (ex as Record<string, unknown>)['.']
    if (typeof dot === 'string') return dot
    if (dot !== null && typeof dot === 'object') {
      const d = dot as Record<string, unknown>
      for (const key of ['import', 'require', 'default']) {
        if (typeof d[key] === 'string') return d[key] as string
      }
    }
  }
  return typeof m.main === 'string' && m.main.trim() !== '' ? m.main : undefined
}

/** The nearest pnpm workspace root (a dir holding `pnpm-workspace.yaml`), walked
 * up from `dir`. Bounded so a weird tree can't loop. */
export function findWorkspaceRoot(dir: string): string | undefined {
  let cur = resolve(dir)
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, 'pnpm-workspace.yaml')) || existsSync(join(cur, 'pnpm-workspace.yml'))) return cur
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

/**
 * Resolve one reference the way the target would: the dev package's own Node
 * lookup first (monorepo workspace links), then the host chain — the dsh install,
 * the chosen profile, the shared profiles root, the home. Returns where it was
 * found (and whether the entry is usable), so the UI can tell "monorepo" from
 * "host-provided" and "missing" from "the link target is gone".
 */
function resolveDevRef(
  dev: DevPlugin, ctx: DshContext, spec: string, profile?: string,
): ResolvedModule | undefined {
  return resolveModule(ctx, spec, { from: dev.dir, ...(profile !== undefined ? { profile } : {}) })
}

/**
 * The names the dev package needs.
 *
 * Declared `dependencies`/`peerDependencies` are always listed — any scope, since
 * the host's own tree has unscoped packages too. Import literals from the built
 * entry are listed ONLY when the composition knows the name (it is a row
 * somewhere): a bundled entry inlines its third-party imports, and reporting every
 * `react`/`antd`/`immer` it happens to mention would bury the real findings.
 */
function collectPeers(m: DevManifest, entryFile: string | undefined, known: (pkg: string) => boolean): string[] {
  const set = new Set<string>()
  for (const source of [m.peerDependencies, m.dependencies]) {
    for (const n of Object.keys(source ?? {})) if (!notAPackage(n)) set.add(packageOf(n))
  }
  if (entryFile !== undefined && existsSync(entryFile)) {
    try {
      for (const hit of readFileSync(entryFile, 'utf8').matchAll(IMPORT_SPEC_RE)) {
        const spec = hit[1]
        if (notAPackage(spec)) continue
        const pkg = packageOf(spec)
        if (known(pkg)) set.add(pkg)
      }
    } catch { /* unreadable entry — declared peers are still reported */ }
  }
  return [...set].sort()
}

// ── registry ────────────────────────────────────────────────────────────────

/** Registered dev plugins (settings-backed, independent of the store). */
export function listDevPlugins(): DevPlugin[] {
  return loadSettings().devPlugins ?? []
}

/** Register a package dir as a dev plugin (idempotent per package name). */
export function registerDevPlugin(dir: string): DevPlugin {
  const target = resolve(dir)
  if (!existsSync(join(target, 'package.json'))) throw new Error('不是有效的插件包（缺少 package.json）')
  const m = readManifest(target)
  const name = typeof m.name === 'string' ? m.name.trim() : ''
  if (name === '') throw new Error('插件包缺少 name 字段')
  const workspaceRoot = findWorkspaceRoot(target)
  const entry: DevPlugin = {
    name,
    dir: target,
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(typeof m.version === 'string' && m.version !== '' ? { version: m.version } : {}),
    bundle: typeof m.dsh?.bundle?.patch === 'string' && m.dsh.bundle.patch.trim() !== '',
    addedAt: new Date().toISOString(),
  }
  updateSettings((draft) => {
    // A re-registration keeps any shims already recorded for this package.
    const prev = (draft.devPlugins ?? []).find(p => p.name === name)
    draft.devPlugins = [...(draft.devPlugins ?? []).filter(p => p.name !== name), { ...entry, ...(prev?.shims !== undefined ? { shims: prev.shims } : {}) }]
  })
  forgetDevDiagnosis()
  logger.info(`dev plugin registered: ${name} (${target})`)
  return entry
}

/** Drop a dev plugin from the registry. Never touches the source dir. */
export function removeDevPlugin(name: string): void {
  updateSettings((draft) => { draft.devPlugins = (draft.devPlugins ?? []).filter(p => p.name !== name) })
  forgetDevDiagnosis()
  logger.info(`dev plugin unregistered: ${name}`)
}

/** Update one registered dev plugin in place (atomic against the current list). */
function updateDevPlugin(name: string, mutate: (dev: DevPlugin) => DevPlugin): void {
  updateSettings((draft) => {
    draft.devPlugins = (draft.devPlugins ?? []).map(p => (p.name === name ? mutate(p) : p))
  })
}

// ── diagnosis ───────────────────────────────────────────────────────────────

/** How a diagnosis is targeted: which chain it resolves against, and who it is. */
interface DiagnoseOptions {
  /** The profile whose composition (and `node_modules`) to resolve against. */
  profile?: string
  /** Bypass the caches — the dialog's 「重新诊断」. */
  refresh?: boolean
  /** Provenance for the report line; the IPC layer is what knows the scope. */
  dsh?: { id: string; name: string; version: string }
}

/** The dev bundle's patch file (its `dsh.bundle.patch`), when the manifest has one. */
function devPatchFile(m: DevManifest, dir: string): string | undefined {
  const rel = m.dsh?.bundle?.patch
  return typeof rel === 'string' && rel.trim() !== '' ? join(dir, rel) : undefined
}

/**
 * Diagnose a dev plugin's resolution against one target: the entry build output,
 * the patch rows dsh actually loads (resolving a row's own `name:` OR the package
 * bound to its `id:` by the composition), and the peers the dev package must
 * resolve.
 *
 * Cached per (target × dev × patch × shims): the dialog exists to be re-run while
 * editing a patch, so a hit is the normal case and `refresh` is the escape hatch.
 */
export function diagnoseDevPlugin(dev: DevPlugin, ctx: DshContext, opts: DiagnoseOptions = {}): DevDiagnosis {
  let m: DevManifest = {}
  try { m = readManifest(dev.dir) } catch { /* unreadable manifest → empty */ }

  const rel = entryRel(m)
  const entry = rel !== undefined ? resolve(dev.dir, rel) : undefined
  const entryMissing = entry !== undefined ? !existsSync(entry) : !existsSync(join(dev.dir, 'index.js'))

  // The patch rows are the modules dsh loads — the real resolution surface.
  const patch = devPatchFile(m, dev.dir)
  const rawRows = patch !== undefined && existsSync(patch)
    ? (() => { try { return parseNamedRows(readFileSync(patch, 'utf8')) } catch { return [] } })()
    : []
  const index = moduleIndexFor(
    ctx, opts.profile, { source: m.name ?? dev.name, rows: rawRows }, patch, opts.refresh === true,
  )

  const patchRows: DevPatchRow[] = rawRows.map((row) => {
    // A row names its package, or addresses one an earlier layer inserted by id.
    const own = (row.name ?? '').trim()
    const binding = own === '' ? bindingFor(index, row.id) : undefined
    const name = own !== '' ? own : binding?.name ?? ''
    const from = binding === undefined ? undefined : binding.source
    if (name === '') return { id: row.id, name: '', nameFrom: 'row' as const }
    const hit = resolveDevRef(dev, ctx, name, opts.profile)
    // What the chosen PROFILE alone would resolve (no dev tree): the verdict a
    // snapshot/copy install of this plugin inside that profile would get.
    const inProfile = opts.profile === undefined ? undefined : resolveModule(ctx, name, { profile: opts.profile })
    const pkg = packageOf(name)
    return {
      id: row.id,
      name,
      nameFrom: own !== '' ? ('row' as const) : ('index' as const),
      ...(pkg !== name ? { pkg } : {}),
      ...(hit !== undefined ? { dir: hit.dir, root: hit.root, state: hit.state, ...(hit.link !== undefined ? { link: hit.link } : {}) } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(inProfile !== undefined && inProfile.dir !== hit?.dir ? { profileDir: inProfile.dir } : {}),
    }
  })
  // A row whose package cannot be imported: nothing has it, or the entry is there
  // but its link target is gone. Both block the load, so both are counted.
  const missingPatchRows = patchRows
    .filter(r => r.name !== '' && (r.dir === undefined || r.state === 'dangling'))
    .map(r => r.name)
  const unknownIds = patchRows.filter(r => r.name === '').map(r => r.id)

  const knownPackages = new Set([
    ...index.bindings.map(b => packageOf(b.name)),
    ...index.bindings.map(b => b.id),
  ])
  const peers: DevPeer[] = collectPeers(m, entry, pkg => knownPackages.has(pkg)).map((n) => {
    const hit = resolveDevRef(dev, ctx, n, opts.profile)
    const pkg = packageOf(n)
    return {
      name: n,
      ...(pkg !== n ? { pkg } : {}),
      ...(hit !== undefined ? { dir: hit.dir, root: hit.root, state: hit.state, ...(hit.link !== undefined ? { link: hit.link } : {}) } : {}),
    }
  })
  // A `link:`'s own imports resolve from the DEV tree only, so a peer the host
  // provides but the dev tree cannot see still needs a shim — the host roots are
  // not on its import path. A DANGLING dev-tree entry does not help it either.
  const missingPeers = peers.filter(p => p.root !== 'monorepo' || p.state === 'dangling').map(p => p.name)

  return {
    entryMissing,
    ...(entry !== undefined ? { entry } : {}),
    ...(patch !== undefined ? { patch } : {}),
    patchRows,
    missingPatchRows,
    peers,
    missingPeers,
    shimmed: dev.shims ?? [],
    index,
    unknownIds,
    meta: {
      dshId: opts.dsh?.id ?? ctx.execPath,
      dshName: opts.dsh?.name ?? ctx.version,
      dshVersion: opts.dsh?.version ?? ctx.version,
      ...(opts.profile !== undefined && opts.profile !== '' ? { profile: opts.profile } : {}),
      at: new Date().toISOString(),
    },
  }
}

// ── diagnosis cache ─────────────────────────────────────────────────────────

/** Distinct diagnoses kept before trimming the oldest. */
const MAX_DIAGNOSES = 32
const diagCache = createKeyedCache<DevDiagnosis>({ max: MAX_DIAGNOSES })

/** Stamp a file's identity, or `-` when it is absent (so its appearance is a
 * change of its own). */
function stamp(path: string | undefined): string {
  if (path === undefined) return '-'
  try {
    const st = statSync(path)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return '-'
  }
}

/** Everything a diagnosis result depends on that a file mtime cannot express. */
function diagKey(dev: DevPlugin, ctx: DshContext, opts: DiagnoseOptions, patch: string | undefined): string {
  return [
    ctx.execPath, ctx.home, ctx.version, opts.profile ?? '', opts.dsh?.id ?? '',
    dev.dir, (dev.shims ?? []).join(','), stamp(patch),
  ].join('\u0000')
}

/** The cached diagnosis for this target, computing it when absent (or when
 * `refresh` asks). The report's `meta.at` is the time it was COMPUTED, so a
 * served-from-cache verdict still shows its real age. */
export function cachedDiagnosis(dev: DevPlugin, ctx: DshContext, opts: DiagnoseOptions = {}): DevDiagnosis {
  let m: DevManifest = {}
  try { m = readManifest(dev.dir) } catch { /* unreadable manifest → empty */ }
  const key = diagKey(dev, ctx, opts, devPatchFile(m, dev.dir))
  return diagCache.get(key, () => diagnoseDevPlugin(dev, ctx, opts), { refresh: opts.refresh === true })
}

/** Drop every cached report and index. Called whenever resolution changes in a way
 * no file stamp can see — the registry itself, or a shim junction written into the
 * dev package (which is what makes a peer resolvable at all). */
export function forgetDevDiagnosis(): void {
  diagCache.forget()
  forgetModuleIndex()
}

// ── peer shims (reversible fallback fix) ────────────────────────────────────

/** Whether `path` is a link we may remove — never a real directory. */
function isRemovableLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Satisfy missing peers by junctioning the host's copies into the dev package's
 * `node_modules`. Only `node_modules` is written (never `package.json`), and the
 * created links are recorded so they can be removed. `pnpm install` in the
 * monorepo will drop them again — the durable fix is to declare the peers there;
 * this is the "make it run now" fallback.
 *
 * The source comes from the same chain the diagnosis reported (`resolveModule`),
 * and a DANGLING entry is re-created rather than skipped: an install upgrade
 * leaves junctions whose target is gone, and `existsSync` cannot see them — which
 * is exactly the case a shim is wanted for.
 */
export function shimDevPeers(
  dev: DevPlugin, ctx: DshContext, opts: DiagnoseOptions = {},
): { added: string[]; skipped: string[] } {
  const diag = cachedDiagnosis(dev, ctx, { ...opts, refresh: true })
  const added: string[] = []
  const skipped: string[] = []
  for (const name of diag.missingPeers) {
    const source = resolveModule(ctx, name, opts.profile !== undefined ? { profile: opts.profile } : {})
    if (source === undefined || source.state === 'dangling' || source.root === 'monorepo') {
      skipped.push(name)
      continue
    }
    const linkPath = join(dev.dir, 'node_modules', name)
    mkdirSync(dirname(linkPath), { recursive: true })
    try {
      if (isRemovableLink(linkPath)) rmSync(linkPath, { force: true })
      else if (existsSync(linkPath)) { skipped.push(name); continue }
      symlinkSync(source.dir, linkPath, 'junction')
      added.push(name)
    } catch (error) {
      logger.warn(`dev peer shim failed for ${name}: ${error instanceof Error ? error.message : String(error)}`)
      skipped.push(name)
    }
  }
  if (added.length > 0) {
    updateDevPlugin(dev.name, p => ({ ...p, shims: [...new Set([...(p.shims ?? []), ...added])] }))
    forgetDevDiagnosis()
  }
  logger.info(`dev peer shim: ${dev.name} added ${added.length}, skipped ${skipped.length}`)
  return { added, skipped }
}

/** Remove every shim junction this launcher created for the dev package. */
export function unshimDevPeers(dev: DevPlugin): string[] {
  const removed: string[] = []
  for (const name of dev.shims ?? []) {
    const linkPath = join(dev.dir, 'node_modules', name)
    if (isRemovableLink(linkPath)) {
      try { rmSync(linkPath, { force: true }); removed.push(name) } catch { /* leave it */ }
    } else {
      // Gone or replaced by a real dir/workspace link — just forget it.
      removed.push(name)
    }
  }
  updateDevPlugin(dev.name, p => ({ ...p, shims: [] }))
  forgetDevDiagnosis()
  logger.info(`dev peer unshim: ${dev.name} removed ${removed.length}`)
  return removed
}

// ── build ───────────────────────────────────────────────────────────────────

/** The package's declared script names (empty when it declares none). */
function readScripts(dir: string): string[] {
  try {
    const m = readManifest(dir) as DevManifest & { scripts?: Record<string, string> }
    return Object.keys(m.scripts ?? {}).sort()
  } catch {
    return []
  }
}

/** The scripts runnable for a dev plugin: its own, and its workspace root's. */
export function devScriptOptions(dev: DevPlugin): DevScriptOptions {
  return {
    package: readScripts(dev.dir),
    workspace: dev.workspaceRoot !== undefined ? readScripts(dev.workspaceRoot) : [],
  }
}

/** The build target to use when the user has not chosen one: the package's own
 * `build`, else the workspace root's (a monorepo often keeps the aggregate build
 * there), else the first script of either. `undefined` when there are none. */
export function defaultDevBuild(dev: DevPlugin): DevBuildTarget | undefined {
  const opts = devScriptOptions(dev)
  if (opts.package.includes('build')) return { script: 'build', scope: 'package' }
  if (opts.workspace.includes('build')) return { script: 'build', scope: 'workspace' }
  const pkg = opts.package[0]
  if (pkg !== undefined) return { script: pkg, scope: 'package' }
  const ws = opts.workspace[0]
  if (ws !== undefined) return { script: ws, scope: 'workspace' }
  return undefined
}

/** Run a build script for the dev plugin — its remembered target, else the
 * default. `scope` picks where: the package (`--filter <name> run <script>`) or
 * its workspace root (`run <script>`). The choice is remembered. */
export async function buildDevPlugin(dev: DevPlugin, target?: DevBuildTarget): Promise<DevRunResult> {
  const chosen = target ?? dev.build ?? defaultDevBuild(dev)
  if (chosen === undefined) throw new Error('该包及其工作区都没有可运行的脚本')
  const cwd = chosen.scope === 'workspace' ? (dev.workspaceRoot ?? dev.dir) : dev.dir
  const args = chosen.scope === 'workspace'
    ? ['run', chosen.script]
    : ['--filter', dev.name, 'run', chosen.script]
  // `run` rejects a bare `--store-dir`, and the user's own repo should use its
  // own store — so no injection here.
  const result = await runPnpm(cwd, args, undefined, { skipStoreDir: true })
  updateDevPlugin(dev.name, p => ({ ...p, build: chosen }))
  logger.info(`dev plugin build: ${dev.name} (${chosen.scope}:${chosen.script}) → ${result.ok ? 'ok' : 'failed'}`)
  return { ok: result.ok, text: result.text, command: result.command ?? `pnpm ${args.join(' ')}`, cwd }
}

/** Install the dev package's own dependencies (in its workspace root when it has
 * one) — the durable fix for missing `@deepseek-ai/*` peers. Runs against the
 * user's repo, so it uses that repo's pnpm store, not the launcher's. */
export async function installDevDeps(dev: DevPlugin): Promise<DevRunResult> {
  const cwd = dev.workspaceRoot ?? dev.dir
  const args = ['install', '--config.confirmModulesPurge=false']
  const result = await runPnpm(cwd, args, undefined, { skipStoreDir: true })
  logger.info(`dev plugin install: ${dev.name} → ${result.ok ? 'ok' : 'failed'}`)
  return { ok: result.ok, text: result.text, command: result.command ?? `pnpm ${args.join(' ')}`, cwd }
}
