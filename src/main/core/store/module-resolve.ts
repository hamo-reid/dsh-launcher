/**
 * Where a NAME resolves on disk — the dev package's own tree, the dsh install,
 * the profile, the shared profiles root, or the home.
 *
 * (The companion question — which package a patch row's `id:` NAMES — lives in
 * `module-index.ts`.)
 *
 * Why this is not a `join(root, 'node_modules', name)` probe: the host installs
 * with pnpm, so `<install>/node_modules/@deepseek-ai/` holds ONLY `dsh` and every
 * other module sits under `.pnpm/<pkg>@<ver>_<hash>/node_modules` or the
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
 *
 * This module is what lets `module-index.ts` and `combo.ts` share one chain
 * without either importing the other: it depends on nothing above `home.ts` /
 * `subdeps.ts`, and neither of those imports `store/`.
 */
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { dshHome, installAnchor, profileDir, profilesDir } from '../profile/home.ts'
import { resolveBundleSubdepDir } from './subdeps.ts'
import type { DshContext } from '../profile/appState.ts'
import type { DevResolveRoot, DevResolveState } from '../../../shared/types.ts'

/** The package part of an import spec: `@s/p/sub/x` → `@s/p`, `p/sub` → `p`. */
export function packageOf(spec: string): string {
  const clean = spec.trim().replace(/\/+$/, '')
  if (!clean.startsWith('@')) return clean.split('/')[0]
  const parts = clean.split('/')
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : clean
}

/** `realpathSync` that degrades to its input (a broken link must not throw). */
function safeRealpath(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

/** A probed directory: where it is, whether it is usable, and — when it is a link
 * whose target is gone — what it pointed at. */
interface ProbedDir {
  dir: string
  state: DevResolveState
  link?: string
}

/** Probe one candidate module dir, telling "absent" from "a link whose target is
 * gone". `undefined` = not a package here, so the search continues. */
function probeModuleDir(dir: string): ProbedDir | undefined {
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

/**
 * The Node lookup dirs a package directory resolves against — its own
 * `node_modules`, each ancestor's, pnpm's virtual store, and the hoist dir —
 * nearest first, in Node's own order.
 *
 * Keyed on the ANCHOR only, never on the requested name: `resolve.paths()` derives
 * the list from the requiring module's location alone, so one call serves every
 * package. That is what lets `moduleSearchRoots` hand back a plain dir list that
 * callers with a different existence criterion (a bundle patch file, not a
 * manifest) can still walk.
 */
function chainDirs(pkgDir: string): string[] {
  const anchor = join(pkgDir, 'package.json')
  if (!existsSync(anchor)) return []
  return createRequire(anchor).resolve.paths('') ?? []
}

/** Probe `pkg` through the Node lookup chain anchored at `fromDir`'s manifest —
 * how a package really resolves its dependencies (pnpm's links included). */
function probeChain(fromDir: string, pkg: string): ProbedDir | undefined {
  for (const dir of chainDirs(fromDir)) {
    const hit = probeModuleDir(join(dir, pkg))
    if (hit !== undefined) return hit
  }
  return undefined
}

/** The installed dsh PACKAGE dir (realpathed) — the anchor the host resolves its
 * own modules from. The install anchor itself is the version dir, whose manifest
 * resolves nothing (`@deepseek-ai/dsh` is its only neighbour there). */
function hostPackageDir(anchor: string | undefined): string | undefined {
  if (anchor === undefined) return undefined
  for (const rel of ['node_modules/@deepseek-ai/dsh', 'node_modules/.pnpm/node_modules/@deepseek-ai/dsh']) {
    const dir = join(anchor, ...rel.split('/'))
    if (existsSync(join(dir, 'package.json'))) return safeRealpath(dir)
  }
  const viaRequire = resolveBundleSubdepDir(anchor, '@deepseek-ai/dsh')
  return viaRequire === undefined ? undefined : safeRealpath(viaRequire)
}

/**
 * Every dir where `<dir>/<pkg>` might be the package, nearest first — the single
 * definition of "where a module can live" on this dsh:
 *
 * 1. the install's own Node lookup chain, anchored at the REALPATHED dsh package.
 *    On a pnpm install this is the only path that reaches the modules dsh itself
 *    loads: `<anchor>/node_modules/@deepseek-ai/` holds just `dsh`, and its
 *    dependencies live in `.pnpm/<pkg>@<ver>_<hash>/node_modules`;
 * 2. the flat `<anchor>/node_modules`, for a non-pnpm (or hand-assembled) install.
 *    On a pnpm install it finds nothing and (1) has already answered;
 * 3. the profile's own tree, then the shared profiles root, then the home — kept
 *    apart rather than merged into one `host-fallback` label, so a caller can tell
 *    "this profile" from "every profile".
 */
export function moduleSearchRoots(
  ctx: DshContext, profile?: string,
): { root: DevResolveRoot; dir: string }[] {
  const roots: { root: DevResolveRoot; dir: string }[] = []
  const anchor = installAnchor(ctx)
  const host = hostPackageDir(anchor)
  if (host !== undefined) for (const dir of chainDirs(host)) roots.push({ root: 'host', dir })
  if (anchor !== undefined) roots.push({ root: 'host', dir: join(anchor, 'node_modules') })
  if (profile !== undefined && profile !== '') {
    roots.push({ root: 'profile', dir: join(profileDir(ctx, profile), 'node_modules') })
  }
  roots.push({ root: 'host-fallback', dir: join(profilesDir(ctx), 'node_modules') })
  roots.push({ root: 'home', dir: join(dshHome(ctx), 'node_modules') })
  return roots
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
  for (const { root, dir } of moduleSearchRoots(ctx, opts.profile)) {
    const hit = probeModuleDir(join(dir, pkg))
    if (hit !== undefined) return { ...hit, root }
  }
  return undefined
}
