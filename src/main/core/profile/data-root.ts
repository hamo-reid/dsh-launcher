/**
 * Relocating the launcher's data root: the dry run, the copy, its verification,
 * and the dsh registry rewrite that has to follow it.
 *
 * Filesystem-only — no Electron, no settings writes. The caller
 * (`ipc/app/data-root.ts`) owns validation, the busy gate and the single
 * settings write. That split is what makes a partial failure safe: nothing ever
 * points at the new root until every requested item has landed AND verified, so
 * a failed run leaves the app exactly where it started.
 *
 * Profiles are deliberately out of scope. They stay at `<home>/profiles`,
 * derived from `DshContext.home` alone (docs/design/profile-layout.md §7).
 */
import { cp, mkdir, rename } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { discoverVersionRepo } from '../dsh/version-repo.ts'
import { logger } from '../shared/logger.ts'
import type {
  DataRootItemKey, DataRootMoveResult, DataRootPlan, DataRootPlanItem, DshEntry,
} from '../../../shared/types.ts'

/** pnpm's content-addressed cache. Rebuildable from the archive, can run to
 * gigabytes, and copying it would roughly double the footprint — so it is the
 * one thing a migration deliberately leaves behind. Each archived version keeps
 * its own resolved `node_modules`, so what lands is self-contained. */
const PNPM_STORE = '.pnpm-store'

/** Where each item lives relative to the root. */
const DERIVED: Record<DataRootItemKey, string[]> = {
  plugins: ['plugins'],
  skillLibrary: ['skill-library'],
  dshVersions: ['dsh', 'versions'],
}

/** The path an item takes under `root`. */
export function derivedPath(root: string, key: DataRootItemKey): string {
  return join(root, ...DERIVED[key])
}

/** The source locations to relocate from — the effectively-resolved dirs, so a
 * pre-`dataRoot` single-dir setting is handled without a special case. */
export interface DataRootSources {
  plugins: string
  skillLibrary: string
  dshVersions: string
}

/** Whether a directory exists and holds anything (the same "already installed"
 * judgement `versionExists` uses for install targets). */
function dirOccupied(dir: string): boolean {
  try {
    return existsSync(dir) && readdirSync(dir).length > 0
  } catch {
    return false
  }
}

/** How many entries a source holds, for the dialog's "N items" column. Shallow
 * on purpose: summing a plugin store's bytes means walking every archived
 * `node_modules`, which the overview page already treats as too costly to do
 * automatically. */
function countEntries(dir: string): number {
  try {
    return readdirSync(dir).length
  } catch {
    return 0
  }
}

/** The dsh installs under a version repo, identified exactly the way
 * `discoverVersionRepo` does (an instance owns
 * `node_modules/@deepseek-ai/dsh/package.json`), so a stray directory in the
 * repo is never mistaken for an install. */
export function dshInstancesOf(repoDir: string): DshEntry[] {
  return discoverVersionRepo([], repoDir)
}

/** What moving the three launcher dirs under `target` would cost. Pure reads —
 * safe to call from the dialog on every change of the path field. */
export function planDataRootMove(sources: DataRootSources, target: string): DataRootPlan {
  const items = (Object.keys(DERIVED) as DataRootItemKey[]).map((key): DataRootPlanItem => {
    const from = sources[key]
    // A version repo counts its installs, not its top-level clutter.
    const total = key === 'dshVersions' ? dshInstancesOf(from).length : countEntries(from)
    const absent = key === 'dshVersions' ? total === 0 : !existsSync(from) || total === 0
    return {
      key,
      from,
      to: derivedPath(target, key),
      absent,
      entries: absent ? 0 : total,
      occupied: dirOccupied(derivedPath(target, key)),
    }
  })
  return { target, items, blockers: [] }
}

// ── verification ─────────────────────────────────────────────────────────────

/** One file the copy should have produced. */
interface CopiedFile { size: number }

/** Every file a copy would produce, as relative path → size. Links are
 * followed, because the copy dereferences them. `.pnpm-store` is skipped for
 * the same reason the copy skips it, and a dangling link is skipped rather than
 * failing the walk. */
function walkFiles(root: string, rel = '', out = new Map<string, CopiedFile>()): Map<string, CopiedFile> {
  let entries
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === PNPM_STORE) continue
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    let st
    try {
      st = statSync(join(root, childRel))
    } catch {
      continue // dangling link — the copy skips it too
    }
    if (st.isDirectory()) walkFiles(root, childRel, out)
    else out.set(childRel, { size: st.size })
  }
  return out
}

export interface CopyVerification {
  ok: boolean
  missing: string[]
  mismatched: string[]
}

/** Compare a copy against its source by relative path and file size. Sizes
 * rather than hashes: enough to catch a truncated or half-written tree, at a
 * fraction of the cost on a multi-gigabyte store. */
export function verifyCopy(src: string, dst: string): CopyVerification {
  const missing: string[] = []
  const mismatched: string[] = []
  for (const [rel, file] of walkFiles(src)) {
    let st
    try {
      st = statSync(join(dst, rel))
    } catch {
      missing.push(rel)
      continue
    }
    if (st.size !== file.size) mismatched.push(rel)
  }
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched }
}

// ── the move ─────────────────────────────────────────────────────────────────

/** Skip pnpm's cache anywhere in the tree (the filter sees absolute paths).
 * Normalising to the platform separator first keeps this right for a source
 * path that arrived with forward slashes. */
function keepEntry(src: string): boolean {
  return !src.replaceAll('/', sep).split(sep).includes(PNPM_STORE)
}

/** Copy one tree, renaming an occupied destination aside first. Directories are
 * never merged: a half-old/half-new mix is worse than a clean copy plus an
 * archive the user can delete. */
async function copyTree(from: string, to: string): Promise<{ archived?: string }> {
  let archived: string | undefined
  if (dirOccupied(to)) {
    archived = `${to}.before-migration-${Date.now()}`
    await rename(to, archived)
    logger.info(`data root: destination occupied, kept ${archived}`)
  }
  await mkdir(dirname(to), { recursive: true })
  // dereference: pnpm's junctions cannot be recreated without developer mode on
  // Windows, and the destination should stand on its own anyway.
  await cp(from, to, { recursive: true, dereference: true, filter: keepEntry })
  return archived === undefined ? {} : { archived }
}

/** A registry entry whose install moved. */
export interface DshRemap {
  oldExecPath: string
  newExecPath: string
  oldHome: string
  newHome: string
  newVersionDir: string
}

/** Pair up the installs in the old and new repos by name, so the caller can
 * rewrite the registry. Reading the NEW repo through `discoverVersionRepo`
 * rather than string-building the paths keeps one definition of where a dsh
 * executable and its home live. */
export function planDshRemap(oldRepo: string, newRepo: string): DshRemap[] {
  const after = new Map(dshInstancesOf(newRepo).map(e => [e.name, e]))
  const out: DshRemap[] = []
  for (const before of dshInstancesOf(oldRepo)) {
    const now = after.get(before.name)
    if (now === undefined) continue
    out.push({
      oldExecPath: before.execPath,
      newExecPath: now.execPath,
      oldHome: before.home,
      newHome: now.home,
      newVersionDir: newRepo,
    })
  }
  return out
}

/** Rewrite the registry entries whose install moved. `id` is derived from
 * `execPath` everywhere else in the app, so it moves with it — a stale `id`
 * would make the next `dsh:list` scan re-register the install as a second
 * entry. Every other field (name, version, managed) is kept. */
export function remapDshEntries(entries: DshEntry[], remap: DshRemap[]): DshEntry[] {
  if (remap.length === 0) return entries
  return entries.map((entry) => {
    const hit = remap.find(r => r.oldExecPath === entry.execPath || r.oldHome === entry.home)
    if (hit === undefined) return entry
    return {
      ...entry,
      id: hit.newExecPath,
      execPath: hit.newExecPath,
      home: hit.newHome,
      versionDir: hit.newVersionDir,
    }
  })
}

/** Move the dsh version repo AND the homes sitting beside it.
 *
 * The two are inseparable: `install.ts` and `discoverVersionRepo` both define a
 * home as `<dirname(versionDir)>/homes/<name>`, so moving the repo alone would
 * orphan every home and leave every delete anchored at a directory that no
 * longer exists. Only homes matching a moved install are copied — a custom repo
 * location can have unrelated entries under its `homes/`. */
async function moveDshVersions(from: string, to: string): Promise<{ archived?: string }> {
  const instances = dshInstancesOf(from)
  const moved = await copyTree(from, to)
  const oldHomes = join(dirname(from), 'homes')
  const newHomes = join(dirname(to), 'homes')
  for (const instance of instances) {
    const srcHome = join(oldHomes, instance.name)
    if (!existsSync(srcHome)) continue
    await copyTree(srcHome, join(newHomes, instance.name))
  }
  return moved
}

export interface DataRootMoveOutcome {
  results: DataRootMoveResult[]
  /** Registry rewrites for a moved version repo (empty otherwise). */
  remap: DshRemap[]
  failed: DataRootItemKey[]
}

/** Relocate every requested item, independently. One failure does not stop the
 * others — the caller reports all of them and leaves the settings alone. A
 * re-run after a partial failure is cheap: anything already identical at the
 * destination is recognised and skipped rather than copied twice. */
export async function moveDataRoot(plan: DataRootPlan, keys: DataRootItemKey[]): Promise<DataRootMoveOutcome> {
  const results: DataRootMoveResult[] = []
  const failed: DataRootItemKey[] = []
  let remap: DshRemap[] = []

  for (const item of plan.items) {
    if (!keys.includes(item.key)) continue
    const base = { key: item.key, from: item.from, to: item.to }

    if (item.absent) {
      results.push({ ...base, status: 'absent' })
      continue
    }
    if (verifyCopy(item.from, item.to).ok) {
      results.push({ ...base, status: 'already-there' })
      if (item.key === 'dshVersions') remap = planDshRemap(item.from, item.to)
      continue
    }

    try {
      const moved = item.key === 'dshVersions'
        ? await moveDshVersions(item.from, item.to)
        : await copyTree(item.from, item.to)
      const check = verifyCopy(item.from, item.to)
      if (!check.ok) {
        const detail = `${check.missing.length} missing, ${check.mismatched.length} size-mismatched`
        logger.error(`data root: verification failed for ${item.key} (${detail})`)
        results.push({ ...base, status: 'failed', detail })
        failed.push(item.key)
        continue
      }
      const result: DataRootMoveResult = { ...base, status: 'moved' }
      if (moved.archived !== undefined) result.archived = moved.archived
      results.push(result)
      if (item.key === 'dshVersions') remap = planDshRemap(item.from, item.to)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      logger.error(`data root: moving ${item.key} failed`, error)
      results.push({ ...base, status: 'failed', detail })
      failed.push(item.key)
    }
  }

  return { results, remap, failed }
}
