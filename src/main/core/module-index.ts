/**
 * Module resolution for the dev-plugin diagnosis.
 *
 * Two questions, both about a NAME:
 *  1. Which package does it mean? A patch row carries either a `name:` (the
 *     package it loads) or just an `id:` that ADDRESSES a row some other layer
 *     inserted. The id → package map is per-composition and NOT a mechanical
 *     prefix: in `@deepseek-ai/dsh-base`'s patch `tool-bash` names
 *     `@deepseek-ai/dsh-tool-bash`, but `timer` names
 *     `@deepseek-ai/cordis-plugin-timer`. So the map is parsed out of the layers
 *     the target actually composes (`buildModuleIndex`), never assembled by
 *     string surgery.
 *  2. Where does it resolve on disk? The dev package's own tree, the dsh install,
 *     the profile, the shared profiles root, or the home.
 *
 * Why this is no longer a `join(root, 'node_modules', name)` probe: the host
 * installs with pnpm, so `<install>/node_modules/@deepseek-ai/` holds ONLY `dsh`
 * and every other module sits under `.pnpm/<pkg>@<ver>_<hash>/node_modules` or the
 * `.pnpm/node_modules` hoist. Resolution therefore has to follow Node's own lookup
 * chain from the right anchor — and that anchor must be REALPATHED: a junction
 * path is not on any lookup chain, so a non-realpathed anchor resolves nothing at
 * all on a real install (`createRequire(<junction>/package.json).resolve(...)`
 * throws MODULE_NOT_FOUND).
 *
 * Entries are reported `dangling` when the directory entry exists but its link
 * target is gone. That is not a nicety: an install upgrade leaves junctions in
 * `<home>/profiles/node_modules` pointing at the previous version's `.pnpm` dir,
 * and every `existsSync` check reads those as absent — while replacing one needs
 * to know it is there.
 */
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { listComboPlugins } from './combo.ts'
import { dshHome, homePatchPath, installAnchor, profileDir, profilePatchPath, profilesDir } from './home.ts'
import { parseNamedRows } from './patch.ts'
import { resolveBundleSubdepDir } from './bundle-subdeps.ts'
import { createKeyedCache } from './keyed-cache.ts'
import type { DshContext } from './appState.ts'
import type { DevResolveRoot, DevResolveState, ModuleIndexInfo } from '../../shared/types.ts'

/** The package part of an import spec: `@s/p/sub/x` → `@s/p`, `p/sub` → `p`. */
export function packageOf(spec: string): string {
  const clean = spec.trim().replace(/\/+$/, '')
  if (!clean.startsWith('@')) return clean.split('/')[0]
  const parts = clean.split('/')
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : clean
}

/** One row feeding the index, in composition order. */
export interface ModuleIndexRow { id: string; name: string; source: string }

/**
 * Fold patch rows into the id → package map. Pure.
 *
 * Only rows that NAME a package create bindings — an id-only row is a lookup,
 * which is exactly the case this exists for. The first layer to name an id wins,
 * mirroring the host, where the earliest `insert:` is what creates the entry; a
 * later layer naming that id differently is a real load failure, reported here as
 * a conflict.
 */
export function buildModuleIndex(rows: readonly ModuleIndexRow[], profile?: string): ModuleIndexInfo {
  const bindings: ModuleIndexInfo['bindings'] = []
  const byId = new Map<string, string>()
  const conflicts = new Map<string, { names: Set<string>; sources: Set<string> }>()
  const layers: ModuleIndexInfo['layers'] = []
  const layerOf = new Map<string, { source: string; rows: number }>()

  for (const row of rows) {
    let layer = layerOf.get(row.source)
    if (layer === undefined) {
      layer = { source: row.source, rows: 0 }
      layerOf.set(row.source, layer)
      layers.push(layer)
    }
    layer.rows += 1

    const name = row.name.trim()
    if (name === '') continue
    const bound = byId.get(row.id)
    if (bound === undefined) {
      byId.set(row.id, name)
      bindings.push({ id: row.id, name, source: row.source })
      continue
    }
    if (bound === name) continue
    const conflict = conflicts.get(row.id) ?? { names: new Set([bound]), sources: new Set<string>() }
    conflict.names.add(name)
    const first = bindings.find(b => b.id === row.id)?.source
    if (first !== undefined) conflict.sources.add(first)
    conflict.sources.add(row.source)
    conflicts.set(row.id, conflict)
  }

  return {
    bindings,
    conflicts: [...conflicts].map(([id, c]) => ({ id, names: [...c.names], sources: [...c.sources] })),
    layers,
    ...(profile !== undefined && profile !== '' ? { profile } : {}),
  }
}

/** `realpathSync` that degrades to its input (a broken link must not throw). */
function safeRealpath(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

/** Probe one candidate module dir, telling "absent" from "a link whose target is
 * gone". `undefined` = not a package here, so the search continues. */
export function probeModuleDir(dir: string): ProbedDir | undefined {
  let link = false
  try {
    link = lstatSync(dir).isSymbolicLink()
  } catch {
    return undefined
  }
  if (link) {
    try {
      statSync(dir)
    } catch {
      // Keep the broken target: "repair this link" and "install this package" are
      // different fixes, and only the target says which one applies.
      let target: string | undefined
      try { target = readlinkSync(dir) } catch { target = undefined }
      return { dir, state: 'dangling', ...(target !== undefined ? { link: target } : {}) }
    }
  } else if (!statSync(dir).isDirectory()) {
    return undefined
  }
  return existsSync(join(dir, 'package.json')) ? { dir, state: 'ok' } : undefined
}

/** Probe `pkg` through the Node lookup chain anchored at `fromDir`'s manifest —
 * how a package really resolves its dependencies (pnpm's links included). */
function probeChain(fromDir: string, pkg: string): ProbedDir | undefined {
  const anchor = join(fromDir, 'package.json')
  if (!existsSync(anchor)) return undefined
  for (const searchPath of createRequire(anchor).resolve.paths(pkg) ?? []) {
    const hit = probeModuleDir(join(searchPath, pkg))
    if (hit !== undefined) return hit
  }
  return undefined
}

/** The installed dsh PACKAGE dir (realpathed) — the anchor the host resolves its
 * own modules from. The install anchor itself is the version dir, whose manifest
 * resolves nothing (`@deepseek-ai/dsh` is its only neighbour there). */
function hostPackageDir(ctx: DshContext): string | undefined {
  const anchor = installAnchor(ctx)
  if (anchor === undefined) return undefined
  for (const rel of ['node_modules/@deepseek-ai/dsh', 'node_modules/.pnpm/node_modules/@deepseek-ai/dsh']) {
    const dir = join(anchor, ...rel.split('/'))
    if (existsSync(join(dir, 'package.json'))) return safeRealpath(dir)
  }
  const viaRequire = resolveBundleSubdepDir(anchor, '@deepseek-ai/dsh')
  return viaRequire === undefined ? undefined : safeRealpath(viaRequire)
}

/** The plain module roots, nearest first — the shape `combo.ts`'s `bundleRoots`
 * uses, with "this profile" and "the shared profiles root" kept apart (the single
 * `host-fallback` label used to conflate them). */
export function moduleRoots(ctx: DshContext, profile?: string): { root: DevResolveRoot; dir: string }[] {
  const roots: { root: DevResolveRoot; dir: string }[] = []
  if (profile !== undefined && profile !== '') {
    roots.push({ root: 'profile', dir: join(profileDir(ctx, profile), 'node_modules') })
  }
  roots.push({ root: 'host-fallback', dir: join(profilesDir(ctx), 'node_modules') })
  roots.push({ root: 'home', dir: join(dshHome(ctx), 'node_modules') })
  return roots
}

/** A probed directory: where it is, whether it is usable, and — when it is a link
 * whose target is gone — what it pointed at. */
export interface ProbedDir {
  dir: string
  state: DevResolveState
  link?: string
}

/** Where a name resolves, or `undefined` when nothing has it. */
export type ResolvedModule = ProbedDir & { root: DevResolveRoot }

/**
 * Resolve `spec` the way the target would. `from` is the dev package dir (its own
 * chain wins — a `link:`'s imports resolve from the dev tree first); `profile`
 * adds that profile's `node_modules` to the host roots. A subpath spec
 * (`@scope/pkg/sub`) resolves by its package, so it stops being "missing".
 */
export function resolveModule(
  ctx: DshContext,
  spec: string,
  opts: { from?: string; profile?: string } = {},
): ResolvedModule | undefined {
  const pkg = packageOf(spec)
  if (pkg === '') return undefined
  if (opts.from !== undefined) {
    const local = probeChain(safeRealpath(opts.from), pkg)
    if (local !== undefined) return { ...local, root: 'monorepo' }
  }
  const anchor = installAnchor(ctx)
  const host = hostPackageDir(ctx)
  if (host !== undefined) {
    const hit = probeChain(host, pkg)
    if (hit !== undefined) return { ...hit, root: 'host' }
  }
  // A non-pnpm (or manually assembled) install keeps its modules flat beside the
  // dsh package — the same place `combo.ts`'s bundleRoots looks. On a pnpm install
  // this probe simply finds nothing and the chains above have already answered.
  if (anchor !== undefined) {
    const flat = probeModuleDir(join(anchor, 'node_modules', pkg))
    if (flat !== undefined) return { ...flat, root: 'host' }
  }
  for (const { root, dir } of moduleRoots(ctx, opts.profile)) {
    const hit = probeModuleDir(join(dir, pkg))
    if (hit !== undefined) return { ...hit, root }
  }
  return undefined
}

/** One layer's rows from a patch file (`[]` when it is absent or unreadable). */
function rowsOfFile(path: string, source: string): ModuleIndexRow[] {
  if (!existsSync(path)) return []
  try {
    return parseNamedRows(readFileSync(path, 'utf8')).map(row => ({ id: row.id, name: row.name ?? '', source }))
  } catch {
    return []
  }
}

/**
 * The rows that feed the index, in composition order: the target composition
 * (each bundle layer, then the profile's own patch, then the home patch), then the
 * dev package's own patch last — so an id the dev plugin introduces resolves even
 * before it is linked into a profile, while an id a host bundle already names
 * keeps the host's binding (first wins).
 *
 * With no profile the index holds only the non-profile layers (home) plus the dev
 * patch: ids only mean something inside a composition, and unioning every
 * profile's bundles would invent a map no real run uses. The dialog says so.
 */
export function collectIndexRows(
  ctx: DshContext,
  profile: string | undefined,
  devPatch: { source: string; rows: readonly { id: string; name?: string }[] },
): ModuleIndexRow[] {
  const rows: ModuleIndexRow[] = []
  if (profile !== undefined && profile !== '') {
    for (const row of listComboPlugins(ctx, profile)) {
      rows.push({ id: row.id, name: row.name, source: row.bundle })
    }
    rows.push(...rowsOfFile(profilePatchPath(ctx, profile), 'profile'))
  }
  rows.push(...rowsOfFile(homePatchPath(ctx), 'home'))
  for (const row of devPatch.rows) rows.push({ id: row.id, name: row.name ?? '', source: devPatch.source })
  return rows
}

// ── cache ───────────────────────────────────────────────────────────────────
//
// Reading every layer's patch is the expensive part of a diagnosis, and the whole
// point of this dialog is to be re-run while editing a patch. So the index is
// keyed on the complete input signature INCLUDING the mtime+size of every layer
// file it read: an edit invalidates it immediately, and the TTL is only a backstop
// for the files it cannot see (a profile re-linked behind our back).

/** Backstop only — mtimes are the real invalidation. */
const CACHE_TTL_MS = 5 * 60_000
/** Distinct (ctx × profile × dev-patch) signatures kept before trimming. */
const MAX_ENTRIES = 8

const indexCache = createKeyedCache<ModuleIndexInfo>({ max: MAX_ENTRIES, ttlMs: CACHE_TTL_MS })

/** The signature of every layer file a build reads (an absent file is stamped as
 * such, so it appearing later is itself a change). */
function indexKey(ctx: DshContext, profile: string | undefined, devPatchFile: string | undefined): string {
  return [
    devPatchFile,
    profile !== undefined && profile !== '' ? profilePatchPath(ctx, profile) : undefined,
    homePatchPath(ctx),
  ].map((file) => {
    if (file === undefined) return '-'
    try {
      const st = statSync(file)
      return `${file}:${st.mtimeMs}:${st.size}`
    } catch {
      return `${file}:-`
    }
  }).concat([ctx.execPath, ctx.home, ctx.version, profile ?? '']).join('\u0000')
}

/**
 * The index for this target, cached. `refresh` bypasses the cache (the dialog's
 * 「重新诊断」), and a changed mtime/size of any layer file misses it.
 */
export function moduleIndexFor(
  ctx: DshContext,
  profile: string | undefined,
  devPatch: { source: string; rows: readonly { id: string; name?: string }[] },
  patchFile: string | undefined,
  refresh = false,
): ModuleIndexInfo {
  const key = indexKey(ctx, profile, patchFile)
  return indexCache.get(
    key,
    () => buildModuleIndex(collectIndexRows(ctx, profile, devPatch), profile),
    { refresh },
  )
}

/** Drop every cached index. Called whenever something changes that resolution
 * depends on but the signature cannot see — a dev plugin's shim junctions being
 * written or removed, the registry itself, or a profile link. */
export function forgetModuleIndex(): void {
  indexCache.forget()
}

/** Look up the package bound to a row id (exact id, then the package's own name). */
export function bindingFor(info: ModuleIndexInfo, id: string): { name: string; source: string } | undefined {
  return info.bindings.find(b => b.id === id)
}
