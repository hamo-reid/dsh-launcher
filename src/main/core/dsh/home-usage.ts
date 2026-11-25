/**
 * Disk usage of a dsh HOME (`DSH_HOME`) — never of the dsh install itself.
 *
 * Scope, deliberately:
 *
 *  - The HOME only: `profiles/`, `sessions/`, `attachments/`, `skills/`, … The
 *    dsh INSTALL (the version repo) and the launcher's plugin store are somebody
 *    else's bytes and never enter the walk.
 *  - MANAGED installs only. A detected or globally installed dsh shares the
 *    machine's `~/.dsh` with the host itself: measuring it would report the
 *    host's data as a launcher-managed cost, and none of it is the launcher's.
 *
 * ── why three numbers and not one ──────────────────────────────────────────
 *
 * pnpm hard-links a package body into the store, the dsh install and every
 * profile that depends on it. `stat` reports each link with the full size, so a
 * plain sum counts the same bytes once per link — on a real machine 88% of the
 * files under these homes carry `nlink > 1`. Publishing that sum as "disk usage"
 * would be a lie, and dividing a deduplicated total among its holders would be
 * inventing a number. So bytes are attributed by what is actually knowable:
 *
 *  - every link to it lives inside this home → `reclaimableBytes` (what deleting
 *    the home frees);
 *  - it also has links outside this home      → `sharedBytes` (not necessarily
 *    freed by deleting it).
 *
 * `apparentBytes` keeps the raw sum, so the page can be compared with what a
 * file explorer shows.
 *
 * ── read-only ─────────────────────────────────────────────────────────────
 *
 * This module only ever enumerates and stats. Nothing here writes, moves or
 * deletes: a feature that reports on data must not be able to damage it.
 */

import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { logger } from '../shared/logger.ts'
import { isDeletableDsh } from './probe.ts'
import type {
  DshEntry, DshHomeTarget, DshHomeUsage, HomeBrowseResult, HomeEntryRole, HomeEntryUsage,
} from '../../../shared/types.ts'

/** How a top-level name is LABELLED. Pure data: an unknown name is reported as
 * `unknown`, never dropped — a hidden row is a size nobody can account for. */
const ROLE_OF: Readonly<Record<string, HomeEntryRole>> = {
  profiles: 'profiles',
  sessions: 'sessions',
  attachments: 'attachments',
  storages: 'storages',
  skills: 'skills',
  cache: 'cache',
  logs: 'logs',
  'plugin-data': 'plugin-data',
  '.agent-presets': 'agent-presets',
  // A home-level pnpm project: same story as a profile's node_modules.
  node_modules: 'deps',
  // Root files the host and the launcher both know about.
  'settings.yaml': 'config',
  '.credentials.yaml': 'config',
  '.env': 'config',
  '.anonymous-user-id': 'config',
  'cordis.patch.yml': 'config',
  'AGENTS.md': 'config',
  'package.json': 'config',
  'pnpm-lock.yaml': 'config',
}

/** The role a top-level entry's name maps to (`unknown` when unlisted). */
export function roleOf(name: string): HomeEntryRole {
  return ROLE_OF[name] ?? 'unknown'
}

/** Visited-entry ceiling for ONE home (files + directories). A cold cache over a
 * deep pnpm tree takes a while; the ceiling keeps the IPC call bounded. Hitting
 * it marks the result `truncated` instead of passing a partial sum off as the
 * total. */
const MAX_ENTRIES = 400_000

/** Wall-clock ceiling for ONE home, ms. Generous on purpose: the largest home
 * measured on a development machine was ~39k entries in 3.6 s with a warm cache,
 * and a cold NTFS cache on a slow disk is several times that. This is a manual
 * action behind a spinner, so waiting beats silently reporting half a home. */
const DEADLINE_MS = 45_000

/** Budget overrides — tests use tiny ones to exercise truncation. */
export interface HomeUsageOptions {
  /** Visited-entry ceiling per home. */
  maxEntries?: number
  /** Wall-clock ceiling per home, ms. */
  deadlineMs?: number
}

/** The budget of one home's scan. Shared by every top-level entry: the ceiling
 * bounds the HOME, not each row, or a home with many folders would quietly get
 * many times the work (and many times the deadline). */
interface Budget {
  maxEntries: number
  deadline: number
  visited: number
  truncated: boolean
}

/** One inode met while walking: the size every link reports, its link count, and
 * how many of those links this walk actually saw. */
interface Inode {
  size: number
  nlink: number
  count: number
}

/** The mutable state of one home scan (all of its entries add into one budget,
 * but each entry folds its own numbers). */
interface Walk {
  budget: Budget
  inodes: Map<string, Inode>
  files: number
  errors: number
  /** Count bytes sitting under a `node_modules` directory separately. */
  trackNodeModules: boolean
  nodeModulesBytes: number
  nodeModulesFiles: number
}

/** One measurement of one top-level entry. */
interface Measured {
  apparentBytes: number
  reclaimableBytes: number
  sharedBytes: number
  files: number
  errors: number
  nodeModulesBytes?: number
}

function newBudget(opts: HomeUsageOptions): Budget {
  return {
    maxEntries: opts.maxEntries ?? MAX_ENTRIES,
    deadline: Date.now() + (opts.deadlineMs ?? DEADLINE_MS),
    visited: 0,
    truncated: false,
  }
}

function newWalk(budget: Budget, trackNodeModules: boolean): Walk {
  return {
    budget,
    inodes: new Map<string, Inode>(),
    files: 0,
    errors: 0,
    trackNodeModules,
    nodeModulesBytes: 0,
    nodeModulesFiles: 0,
  }
}

/** Whether the home's budget is spent (`w.truncated` follows this). */
function spent(budget: Budget): boolean {
  if (budget.truncated) return true
  if (budget.visited >= budget.maxEntries || Date.now() > budget.deadline) {
    budget.truncated = true
    return true
  }
  return false
}

/** Record one file. `nlink` is read from disk; `count` accumulates here. */
function addFile(full: string, w: Walk, inNodeModules: boolean): void {
  let st
  try {
    st = statSync(full, { bigint: true })
  } catch {
    // Locked / vanished mid-walk / permission denied. Counted so the page can
    // say the total is a floor instead of quietly reporting a smaller home.
    w.errors += 1
    return
  }
  const size = Number(st.size)
  // The size rides in the key on purpose: two distinct files that happen to
  // report one inode number (seen on some Windows volumes) must not collapse
  // into one and silently lose bytes. Same convention as
  // `core/store/overview.ts` `collectDirInodes`.
  const key = `${String(st.dev)}:${String(st.ino)}:${String(size)}`
  const seen = w.inodes.get(key)
  if (seen === undefined) w.inodes.set(key, { size, nlink: Number(st.nlink), count: 1 })
  else seen.count += 1
  w.files += 1
  if (inNodeModules) {
    w.nodeModulesBytes += size
    w.nodeModulesFiles += 1
  }
}

/** Enumerate a directory tree, recording every file. Iterative on the budget:
 * once it trips, the rest of the tree is not visited at all. */
function walk(dir: string, w: Walk, inNodeModules: boolean): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    w.errors += 1
    return
  }
  for (const entry of entries) {
    if (spent(w.budget)) return
    w.budget.visited += 1
    // A junction / symlink is not this home's bytes: its target is counted where
    // it actually lives, and following it would walk out of the home entirely.
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, w, inNodeModules || entry.name === 'node_modules')
      continue
    }
    if (!entry.isFile()) continue
    addFile(full, w, inNodeModules)
  }
}

/** Fold a set of inodes into the three numbers (see the module header). */
function foldTotals(inodes: Map<string, Inode>): { apparent: number; reclaimable: number; shared: number } {
  let apparent = 0
  let reclaimable = 0
  let shared = 0
  for (const rec of inodes.values()) {
    apparent += rec.size * rec.count
    // `Math.max` guards a filesystem that reports `nlink` 0, or fewer links than
    // this walk just counted: the bytes are provably here, so they must not
    // silently migrate into the "shared with something else" bucket.
    if (Math.max(rec.nlink, rec.count) === rec.count) reclaimable += rec.size
    else shared += rec.size
  }
  return { apparent, reclaimable, shared }
}

/** Fold one entry's walk into its own numbers. */
function resultOf(w: Walk): Measured {
  const totals = foldTotals(w.inodes)
  return {
    apparentBytes: totals.apparent,
    reclaimableBytes: totals.reclaimable,
    sharedBytes: totals.shared,
    files: w.files,
    errors: w.errors,
    ...(w.trackNodeModules && w.nodeModulesFiles > 0 ? { nodeModulesBytes: w.nodeModulesBytes } : {}),
  }
}

/**
 * Add one entry's inodes into the home-wide set.
 *
 * Counts add up across entries, which is the whole point: a file hard-linked
 * into TWO top-level folders of one home is "shared with something else" from
 * either folder's point of view (deleting that folder alone frees nothing), but
 * it IS freed when the whole home goes. Summing the per-entry numbers loses
 * that, so the home total is folded from this merged set instead.
 */
function mergeInto(sink: Map<string, Inode>, src: Map<string, Inode>): void {
  for (const [key, record] of src) {
    const seen = sink.get(key)
    if (seen === undefined) sink.set(key, { size: record.size, nlink: record.nlink, count: record.count })
    else seen.count += record.count
  }
}

/**
 * Measure one child of `parent` (a directory tree, or a single file), returning
 * both the numbers and the inodes it saw so the caller can fold a wider view.
 *
 * Two names get special arithmetic, because their apparent size is really the
 * plugin store's: a `node_modules` dir counts ALL of its bytes as hard-linked in,
 * while a `profiles` dir counts the bytes under its nested `node_modules`.
 */
function measureChild(
  parent: string,
  name: string,
  kind: 'dir' | 'file',
  budget: Budget,
): { measured: Measured; inodes: Map<string, Inode> } {
  const full = join(parent, name)
  const isNodeModules = name === 'node_modules' && kind === 'dir'
  const w = newWalk(budget, (name === 'profiles' || isNodeModules) && kind === 'dir')
  if (kind === 'dir') walk(full, w, isNodeModules)
  else addFile(full, w, false)
  return { measured: resultOf(w), inodes: w.inodes }
}

/**
 * Measure one dsh home. Read-only.
 *
 * `dshIds` is left empty: one home can be shared by several registered dsh, and
 * only the caller knows which. `gatherHomeUsage` fills it.
 * @param home - the `DSH_HOME` to walk.
 * @param opts - budget overrides.
 */
export function measureHome(home: string, opts: HomeUsageOptions = {}): DshHomeUsage {
  const started = Date.now()
  const scannedAt = new Date(started).toISOString()
  const empty = (exists: boolean): DshHomeUsage => ({
    home, dshIds: [], exists,
    apparentBytes: 0, reclaimableBytes: 0, sharedBytes: 0,
    files: 0, errors: 0, truncated: false,
    scannedAt, durationMs: Date.now() - started, entries: [],
  })

  let tops
  try {
    tops = readdirSync(home, { withFileTypes: true })
  } catch {
    // Absent is normal: the host creates its home lazily on first run.
    return empty(false)
  }

  // ONE budget for the whole home: the ceiling bounds the scan, not each row.
  const budget = newBudget(opts)
  const entries: HomeEntryUsage[] = []
  // One set for the whole home, so the totals below describe the HOME rather
  // than the sum of its parts (see `mergeInto`).
  const homeInodes = new Map<string, Inode>()
  let files = 0
  let errors = 0

  for (const top of tops) {
    if (top.isSymbolicLink()) continue
    const kind = top.isDirectory() ? 'dir' : top.isFile() ? 'file' : undefined
    if (kind === undefined) continue
    if (spent(budget)) break
    // Count the entry itself, exactly as `walk` does for a directory's children:
    // a top-level FILE is recorded without descending, so `walk` would never
    // count it and a home made of many files would never trip the ceiling.
    budget.visited += 1
    const { measured, inodes } = measureChild(home, top.name, kind, budget)
    mergeInto(homeInodes, inodes)
    files += measured.files
    errors += measured.errors
    entries.push({
      name: top.name,
      kind,
      role: roleOf(top.name),
      apparentBytes: measured.apparentBytes,
      reclaimableBytes: measured.reclaimableBytes,
      sharedBytes: measured.sharedBytes,
      files: measured.files,
      ...(measured.nodeModulesBytes !== undefined ? { nodeModulesBytes: measured.nodeModulesBytes } : {}),
    })
  }

  // Largest first, name as the tie-break so the order never wobbles between
  // two scans of unchanged data.
  entries.sort((a, b) => b.apparentBytes - a.apparentBytes || a.name.localeCompare(b.name))

  const totals = foldTotals(homeInodes)
  const usage: DshHomeUsage = {
    home, dshIds: [], exists: true,
    apparentBytes: totals.apparent,
    reclaimableBytes: totals.reclaimable,
    sharedBytes: totals.shared,
    files, errors,
    truncated: budget.truncated,
    scannedAt, durationMs: Date.now() - started, entries,
  }
  logger.debug(`home measured: ${home}`, {
    reclaimable: totals.reclaimable, shared: totals.shared, files, truncated: budget.truncated,
  })
  return usage
}

/** One managed home and the dsh that share it — no measurement, just identity. */
export type HomeTarget = DshHomeTarget

/**
 * The MANAGED homes, grouped, WITHOUT walking any of them.
 *
 * Only MANAGED installs qualify (`isDeletableDsh`): a system/global dsh shares
 * `~/.dsh` with the host, and its home is not a launcher cost to report.
 *
 * Cheap on purpose. The page asks for the targets first and then for one home at
 * a time ({@link scanHome}), so results appear as they land and the main process
 * gets an event-loop turn between homes instead of one long freeze — measuring
 * three homes in one call blocked it for seconds with nothing to show for it.
 * @param entries - the registered dsh list.
 * @param versionRoot - the dsh version repo, so a managed install whose
 *   `managed` marker was clobbered is still recognised.
 * @returns one target per home, in registry order.
 */
export function homeTargets(entries: readonly DshEntry[], versionRoot: string): HomeTarget[] {
  const managed = entries.filter(entry => isDeletableDsh(entry, entry.versionDir ?? versionRoot))
  // Several entries can point at one home, and `dsh:setHome` takes free text —
  // so the same directory may be spelled twice (`C:\x` / `c:/x/`, a trailing
  // separator). Group by a canonical key while keeping the first spelling for
  // display, otherwise one home gets measured twice and its bytes shown twice.
  const groups = new Map<string, HomeTarget>()
  for (const entry of managed) {
    const home = resolve(entry.home)
    const key = process.platform === 'win32' ? home.toLowerCase() : home
    const group = groups.get(key) ?? { home, dshIds: [] }
    group.dshIds.push(entry.id)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** Measure ONE managed home, labelling it with the dsh that share it. */
export function scanHome(target: HomeTarget, opts: HomeUsageOptions = {}): DshHomeUsage {
  return { ...measureHome(target.home, opts), dshIds: target.dshIds }
}

/** Largest reclaimable first, so "what would free the most" reads top-down. */
export function sortHomes(rows: readonly DshHomeUsage[]): DshHomeUsage[] {
  return [...rows].sort((a, b) => b.reclaimableBytes - a.reclaimableBytes
    || b.apparentBytes - a.apparentBytes
    || a.home.localeCompare(b.home))
}

/**
 * Measure every managed home in one call.
 *
 * Kept for callers that want the whole picture at once (and for the grouping
 * rules to be testable without a renderer). The DSH page does NOT use it: it
 * walks {@link homeTargets} + {@link scanHome} so a long scan can report
 * progress.
 * @param entries - the registered dsh list.
 * @param versionRoot - the dsh version repo.
 * @param opts - budget overrides.
 * @returns one row per managed home, largest reclaimable first.
 */
export function gatherHomeUsage(
  entries: readonly DshEntry[],
  versionRoot: string,
  opts: HomeUsageOptions = {},
): DshHomeUsage[] {
  return sortHomes(homeTargets(entries, versionRoot).map(target => scanHome(target, opts)))
}

// ── structure browser ──────────────────────────────────────────────────────

/** Children returned per level unless the caller asks for fewer. A level can
 * hold thousands of names (`node_modules/.pnpm`), and every one of them is
 * measured, so the list is capped and the remainder reported as `omitted`
 * instead of handing the renderer an enormous payload. */
const DEFAULT_CHILD_LIMIT = 200

/**
 * Resolve a home-relative path, or `undefined` when it would leave the home.
 *
 * The path arrives from the renderer, so it is treated as hostile: `..`, an
 * absolute path, a drive swap and anything that resolves outside the home must
 * fail here rather than reach the filesystem. It lives beside the measurement
 * (not in the IPC layer) so the browse and reveal entry points share one
 * definition of "inside this home".
 * @param home - the home root.
 * @param relPath - a path relative to `home`, `/` or `\` separated; '' = the root.
 */
export function resolveInHome(home: string, relPath: string): string | undefined {
  const base = resolve(home)
  const target = resolve(base, relPath.replace(/[\\/]+/g, '/'))
  if (target === base) return target
  // A drive root keeps its separator, so do not double it when building the prefix.
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return target.startsWith(prefix) ? target : undefined
}

/** The `/`-separated path of `dir` relative to `home` ('' for the root itself). */
function relOf(home: string, dir: string): string {
  const rel = relative(home, dir).replace(/\\/g, '/')
  return rel === '.' ? '' : rel
}

/** Options for {@link browseDir}. */
export interface BrowseOptions extends HomeUsageOptions {
  /** Ceiling on RETURNED children (the largest ones). */
  limit?: number
}

/**
 * List ONE level of a home: every child measured, largest first. Read-only.
 *
 * One level at a time on purpose. A home is deep (`profiles` → a profile →
 * `node_modules` → `.pnpm` → …), and measuring the whole tree just to paint a
 * collapsed one would cost far more than the level the person actually opened.
 * The caller descends by asking for the child that was clicked.
 *
 * `omitted` is returned rather than silently slicing: a level that shows 200 of
 * 4,000 rows must say so, or the numbers under it look like the whole story.
 * @param home - the home root, used for the relative path reported back.
 * @param dir - the ABSOLUTE directory to list (pass {@link resolveInHome} first).
 * @param opts - row limit and scan budget.
 */
export function browseDir(home: string, dir: string, opts: BrowseOptions = {}): HomeBrowseResult {
  const started = Date.now()
  const base = resolve(home)
  const target = resolve(dir)
  const scannedAt = new Date(started).toISOString()
  const missing: HomeBrowseResult = {
    home: base, relPath: relOf(base, target), path: target, exists: false,
    apparentBytes: 0, reclaimableBytes: 0, sharedBytes: 0,
    files: 0, errors: 0, omitted: 0, truncated: false,
    scannedAt, durationMs: Date.now() - started, entries: [],
  }

  let children
  try {
    children = readdirSync(target, { withFileTypes: true })
  } catch {
    return missing
  }

  // ONE budget for the level, so a directory with thousands of children cannot
  // multiply the work by its width.
  const budget = newBudget(opts)
  const all: HomeEntryUsage[] = []
  // How many entries this level actually HAS — from the dirents alone, no I/O.
  // Counted up front so `omitted` still accounts for children the budget never
  // reached; a level that bailed out after two of forty must say thirty-eight are
  // missing, not "zero".
  const totalEntries = children.filter(child =>
    !child.isSymbolicLink() && (child.isDirectory() || child.isFile())).length
  let apparentBytes = 0
  let reclaimableBytes = 0
  let sharedBytes = 0
  let files = 0
  let errors = 0

  for (const child of children) {
    if (spent(budget)) break
    if (child.isSymbolicLink()) continue
    const kind = child.isDirectory() ? 'dir' : child.isFile() ? 'file' : undefined
    if (kind === undefined) continue
    // A level of single files never descends, so the ceiling must count them here
    // (see the same note in `measureHome`).
    budget.visited += 1
    const m = measureChild(target, child.name, kind, budget).measured
    apparentBytes += m.apparentBytes
    reclaimableBytes += m.reclaimableBytes
    sharedBytes += m.sharedBytes
    files += m.files
    errors += m.errors
    all.push({
      name: child.name,
      kind,
      role: roleOf(child.name),
      apparentBytes: m.apparentBytes,
      reclaimableBytes: m.reclaimableBytes,
      sharedBytes: m.sharedBytes,
      files: m.files,
      ...(m.nodeModulesBytes !== undefined ? { nodeModulesBytes: m.nodeModulesBytes } : {}),
    })
  }

  all.sort((a, b) => b.apparentBytes - a.apparentBytes || a.name.localeCompare(b.name))
  const limit = Math.max(1, opts.limit ?? DEFAULT_CHILD_LIMIT)
  const kept = all.slice(0, limit)

  return {
    home: base, relPath: relOf(base, target), path: target, exists: true,
    apparentBytes, reclaimableBytes, sharedBytes, files, errors,
    omitted: Math.max(0, totalEntries - kept.length),
    truncated: budget.truncated,
    scannedAt, durationMs: Date.now() - started, entries: kept,
  }
}
