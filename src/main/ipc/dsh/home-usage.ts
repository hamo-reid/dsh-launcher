/**
 * IPC for the dsh home: which managed homes exist (`home:targets`), measuring
 * one of them (`home:scan`), the structure browser (`home:browse`) and
 * revealing a folder (`home:reveal`).
 *
 * Read-only by construction. There is deliberately no cleanup channel: a feature
 * that reports on data must not be able to delete it, and the one sanctioned
 * destructive helper in this repo is `scripts/safe-remove.ps1` (see AGENTS.md) —
 * never a bare recursive delete reachable from a "show me the sizes" button.
 *
 * Why one home per call: measuring a home is a synchronous walk (≈600 ms for a
 * 35k-file home). Doing every home in one request blocked the main process for
 * seconds with a single spinner; splitting it lets the page paint each result as
 * it lands and gives the event loop a turn between homes.
 *
 * Every path crosses the boundary from the renderer, so both halves of the check
 * happen HERE: the home must be one this launcher actually manages (a system dsh
 * sharing `~/.dsh` with the host is not ours to hand out), and the sub-path must
 * resolve back inside it (`resolveInHome`).
 */

import { shell } from 'electron'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { dshVersionDir, readDshState } from '../../core/profile/appState.ts'
import { browseDir, homeTargets, resolveInHome, scanHome } from '../../core/dsh/home-usage.ts'
import { fail, E } from '../../core/shared/errors.ts'
import { handle } from '../handle.ts'
import type {
  DshHomeTarget, DshHomeUsage, HomeBrowseResult, IpcResult,
} from '../../../shared/types.ts'

/** The managed homes as the registry currently describes them. */
function managedHomes(): DshHomeTarget[] {
  return homeTargets(readDshState().dshes, dshVersionDir())
}

/** The managed home this request names — or `undefined` when the launcher does
 * not manage it. Returns the target so the caller also has its owners. */
function managedHomeFor(home: unknown): DshHomeTarget | undefined {
  if (typeof home !== 'string' || home.trim() === '') return undefined
  const target = resolve(home.trim())
  return managedHomes().find(entry => entry.home === target)
}

/** A renderer-supplied path fragment, or `''` — `undefined` when it is not a string. */
function relPathOf(relPath: unknown): string | undefined {
  if (relPath === undefined || relPath === null) return ''
  return typeof relPath === 'string' ? relPath : undefined
}

export function registerHomeUsageIpc(): void {
  // The managed homes, WITHOUT measuring any of them. Cheap: settings only.
  handle('home:targets', (): IpcResult<DshHomeTarget[]> => ({
    ok: true,
    value: managedHomes(),
  }))

  // Measure ONE managed home. The page calls this once per target.
  handle('home:scan', (_event, home: unknown): IpcResult<DshHomeUsage> => {
    const target = managedHomeFor(home)
    if (target === undefined) return fail(E.dshNotFound)
    return { ok: true, value: scanHome(target) }
  })

  // List ONE level of a home for the structure browser. The child the user
  // clicks is its own call, so a deep tree costs only the levels opened.
  handle('home:browse', (_event, home: unknown, relPath?: unknown, limit?: unknown): IpcResult<HomeBrowseResult> => {
    const target = managedHomeFor(home)
    if (target === undefined) return fail(E.dshNotFound)
    const rel = relPathOf(relPath)
    if (rel === undefined) return fail(E.homePathInvalid)
    const dir = resolveInHome(target.home, rel)
    if (dir === undefined) return fail(E.homePathInvalid)
    const cap = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? { limit } : {}
    return { ok: true, value: browseDir(target.home, dir, cap) }
  })

  // Reveal a managed home — or a sub-directory of it — in the OS file explorer.
  handle('home:reveal', async (_event, home: unknown, relPath?: unknown): Promise<IpcResult<boolean>> => {
    const target = managedHomeFor(home)
    if (target === undefined) return fail(E.dshNotFound)
    const rel = relPathOf(relPath)
    if (rel === undefined) return fail(E.homePathInvalid)
    const dir = resolveInHome(target.home, rel)
    if (dir === undefined) return fail(E.homePathInvalid)
    // `shell.openPath` hands the path to the OS: a FILE is opened by its default
    // handler, and a dsh home contains readable `.cmd` / `.exe` shims under
    // `node_modules/.bin` — opening one EXECUTES it. "Reveal this folder" must
    // never be able to run something, so only a directory gets through.
    let isDir = false
    try {
      isDir = statSync(dir).isDirectory()
    } catch {
      // Missing / unreadable: reported as "not a folder" rather than opened.
    }
    if (!isDir) return fail(E.homeNotDir, { detail: dir })
    const error = await shell.openPath(dir)
    return error === '' ? { ok: true, value: true } : fail(E.shellOpenPath, { detail: error })
  })
}
