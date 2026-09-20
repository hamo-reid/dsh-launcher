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
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadSettings, updateSettings } from './settings.ts'
import { parseNamedRows } from './patch.ts'
import { installAnchor } from './home.ts'
import { resolveBundleSubdepDir } from './bundle-subdeps.ts'
import { runPnpm } from './pnpm.ts'
import { logger } from './logger.ts'
import type { DshContext } from './appState.ts'
import type { DevDiagnosis, DevPatchRow, DevPeer, DevPlugin, DevResolveRoot } from '../../shared/types.ts'

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

/** `@deepseek-ai/<name>` literals, for finding undeclared peers in built code. */
const DSH_IMPORT_RE = /@deepseek-ai\/[a-z0-9-]+/gi

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

/** Resolve `name` from a package dir the way Node would (its own lookup chain). */
function resolveFromPackage(dir: string, name: string): string | undefined {
  return resolveBundleSubdepDir(dir, name)
}

/** The host-provided roots, checked AFTER the dev package's own lookup. Mirrors
 * the host's chain: the dsh install anchor (its own `@deepseek-ai/*`), the shared
 * profiles root (the host's heal fallback), then the dsh home. A `link:`'s own
 * imports never traverse a profile, so per-profile roots are not consulted. */
function hostRoots(ctx: DshContext): { root: DevResolveRoot; dir: string }[] {
  const out: { root: DevResolveRoot; dir: string }[] = []
  const anchor = installAnchor(ctx)
  if (anchor !== undefined) out.push({ root: 'host', dir: anchor })
  out.push({ root: 'host-fallback', dir: join(ctx.home, 'profiles') })
  out.push({ root: 'home', dir: ctx.home })
  return out
}

/** Resolve a dev-plugin reference the way the host would: the dev package's own
 * Node lookup first (monorepo workspace links), then the host roots. Returns
 * where it was found, so the UI can tell "monorepo" from "host-provided". */
function resolveDevRef(
  dev: DevPlugin, ctx: DshContext, name: string,
): { dir: string; root: DevResolveRoot } | undefined {
  const local = resolveFromPackage(dev.dir, name)
  if (local !== undefined) return { dir: local, root: 'monorepo' }
  for (const { root, dir } of hostRoots(ctx)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return { dir: candidate, root }
  }
  return undefined
}

/** `@deepseek-ai/*` names the dev package needs: declared peers/deps plus any
 * literal imported by the built entry (catches undeclared host services). */
function collectPeers(m: DevManifest, entryFile: string | undefined): string[] {
  const set = new Set<string>()
  for (const n of Object.keys(m.peerDependencies ?? {})) if (n.startsWith('@deepseek-ai/')) set.add(n)
  for (const n of Object.keys(m.dependencies ?? {})) if (n.startsWith('@deepseek-ai/')) set.add(n)
  if (entryFile !== undefined && existsSync(entryFile)) {
    try {
      for (const hit of readFileSync(entryFile, 'utf8').matchAll(DSH_IMPORT_RE)) set.add(hit[0])
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
  logger.info(`dev plugin registered: ${name} (${target})`)
  return entry
}

/** Drop a dev plugin from the registry. Never touches the source dir. */
export function removeDevPlugin(name: string): void {
  updateSettings((draft) => { draft.devPlugins = (draft.devPlugins ?? []).filter(p => p.name !== name) })
  logger.info(`dev plugin unregistered: ${name}`)
}

/** Update one registered dev plugin in place (atomic against the current list). */
export function updateDevPlugin(name: string, mutate: (dev: DevPlugin) => DevPlugin): void {
  updateSettings((draft) => {
    draft.devPlugins = (draft.devPlugins ?? []).map(p => (p.name === name ? mutate(p) : p))
  })
}

// ── diagnosis ───────────────────────────────────────────────────────────────

/** Diagnose a dev plugin's resolution: entry build output, the patch rows dsh
 * actually loads, and the `@deepseek-ai/*` peers the dev package must resolve. */
export function diagnoseDevPlugin(dev: DevPlugin, ctx: DshContext): DevDiagnosis {
  let m: DevManifest = {}
  try { m = readManifest(dev.dir) } catch { /* unreadable manifest → empty */ }

  const rel = entryRel(m)
  const entry = rel !== undefined ? resolve(dev.dir, rel) : undefined
  const entryMissing = entry !== undefined ? !existsSync(entry) : !existsSync(join(dev.dir, 'index.js'))

  // The patch rows are the modules dsh loads — the real resolution surface.
  const patchRel = m.dsh?.bundle?.patch
  const patch = typeof patchRel === 'string' && patchRel.trim() !== '' ? join(dev.dir, patchRel) : undefined
  const patchRows: DevPatchRow[] = []
  if (patch !== undefined && existsSync(patch)) {
    try {
      for (const row of parseNamedRows(readFileSync(patch, 'utf8'))) {
        const name = row.name ?? ''
        const hit = name === '' ? undefined : resolveDevRef(dev, ctx, name)
        patchRows.push({ id: row.id, name, ...(hit !== undefined ? { dir: hit.dir, root: hit.root } : {}) })
      }
    } catch { /* unreadable patch → no rows to report */ }
  }
  const missingPatchRows = patchRows.filter(r => r.name !== '' && r.dir === undefined).map(r => r.name)

  const peers: DevPeer[] = collectPeers(m, entry).map(n => {
    const hit = resolveDevRef(dev, ctx, n)
    return { name: n, ...(hit !== undefined ? { dir: hit.dir, root: hit.root } : {}) }
  })
  // A `link:`'s own imports resolve from the DEV tree only, so a peer the host
  // provides but the dev tree cannot see still needs a shim — the host roots are
  // not on its import path.
  const missingPeers = peers.filter(p => p.root !== 'monorepo').map(p => p.name)

  return {
    entryMissing,
    ...(entry !== undefined ? { entry } : {}),
    ...(patch !== undefined ? { patch } : {}),
    patchRows,
    missingPatchRows,
    peers,
    missingPeers,
    shimmed: dev.shims ?? [],
  }
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
 * Satisfy missing `@deepseek-ai/*` peers by junctioning the dsh install's copies
 * into the dev package's `node_modules`. Only `node_modules` is written (never
 * `package.json`), and the created links are recorded so they can be removed.
 * `pnpm install` in the monorepo will drop them again — the durable fix is to
 * declare the peers there; this is the "make it run now" fallback.
 */
export function shimDevPeers(dev: DevPlugin, ctx: DshContext): { added: string[]; skipped: string[] } {
  const diag = diagnoseDevPlugin(dev, ctx)
  const added: string[] = []
  const skipped: string[] = []
  for (const name of diag.missingPeers) {
    // Source from wherever the host provides it (install anchor, heal fallback,
    // dsh home) — the same roots the diagnosis reports.
    const source = hostRoots(ctx)
      .map(r => join(r.dir, 'node_modules', name))
      .find(d => existsSync(join(d, 'package.json')))
    if (source === undefined) { skipped.push(name); continue }
    const linkPath = join(dev.dir, 'node_modules', name)
    mkdirSync(dirname(linkPath), { recursive: true })
    try {
      if (existsSync(linkPath)) {
        if (!isRemovableLink(linkPath)) { skipped.push(name); continue }
        rmSync(linkPath, { force: true })
      }
      symlinkSync(source, linkPath, 'junction')
      added.push(name)
    } catch (error) {
      logger.warn(`dev peer shim failed for ${name}: ${error instanceof Error ? error.message : String(error)}`)
      skipped.push(name)
    }
  }
  if (added.length > 0) {
    updateDevPlugin(dev.name, p => ({ ...p, shims: [...new Set([...(p.shims ?? []), ...added])] }))
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
  logger.info(`dev peer unshim: ${dev.name} removed ${removed.length}`)
  return removed
}

// ── build ───────────────────────────────────────────────────────────────────

/** Run the package's build script (in its workspace root when it has one), so a
 * monorepo package's `exports` target actually exists. */
export async function buildDevPlugin(dev: DevPlugin, script = 'build'): Promise<{ ok: boolean; text: string }> {
  const cwd = dev.workspaceRoot ?? dev.dir
  const args = dev.workspaceRoot !== undefined
    ? ['--filter', dev.name, 'run', script]
    : ['run', script]
  const result = await runPnpm(cwd, args)
  logger.info(`dev plugin build: ${dev.name} (${script}) → ${result.ok ? 'ok' : 'failed'}`)
  return { ok: result.ok, text: result.text }
}

/** Install the dev package's own dependencies (in its workspace root when it has
 * one) — the durable fix for missing `@deepseek-ai/*` peers. */
export async function installDevDeps(dev: DevPlugin): Promise<{ ok: boolean; text: string }> {
  const cwd = dev.workspaceRoot ?? dev.dir
  const result = await runPnpm(cwd, ['install', '--config.confirmModulesPurge=false'])
  logger.info(`dev plugin install: ${dev.name} → ${result.ok ? 'ok' : 'failed'}`)
  return { ok: result.ok, text: result.text }
}
