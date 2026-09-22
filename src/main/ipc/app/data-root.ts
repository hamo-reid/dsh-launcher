/** IPC for the launcher data root (`settings:getDataRoot` /
 * `settings:previewDataRoot` / `settings:applyDataRoot`): what the root
 * currently derives, a dry run of a relocation, and applying one.
 *
 * Switching the root and migrating the data are deliberately ONE handler. The
 * migration has to resolve the source dirs before the settings change — after
 * it, `pluginDir()` already answers with the new path — so splitting them into
 * "set root" + "move data" would need a persisted "previous root", exactly the
 * kind of drifting state `appState.ts` exists to avoid. The two-phase shape is
 * still there for the UI (preview = probe, apply = execute), matching the
 * existing `store:needsMigration` / `store:migrate` pair. */

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { handle } from '../handle.ts'
import { E, fail } from '../../core/shared/errors.ts'
import { logger } from '../../core/shared/logger.ts'
import { flushSettings, patchSettings } from '../../core/settings/settings.ts'
import {
  configuredDataRoot, dataRoot, dshVersionDir, legacyDirOverrides, pluginDir, skillLibraryDir,
  updateDshState,
} from '../../core/profile/appState.ts'
import {
  moveDataRoot, planDataRootMove, remapDshEntries, type DataRootSources,
} from '../../core/profile/data-root.ts'
import { repairArchiveLinks } from '../../core/store/plugins.ts'
import { ensurePluginStore } from '../plugins/plugins.ts'
import { listPluginDownloads } from '../../core/store/downloads.ts'
import { listRuns } from '../dsh/run.ts'
import type {
  DataRootApplyResult, DataRootItemKey, DataRootMoveResult, DataRootPlan, DataRootState, IpcResult,
} from '../../../shared/types.ts'

const ITEM_KEYS: DataRootItemKey[] = ['plugins', 'skillLibrary', 'dshVersions']

/** The three effective source dirs, read at call time so a pre-`dataRoot`
 * single-dir setting is handled without a special case. */
function currentSources(): DataRootSources {
  return { plugins: pluginDir(), skillLibrary: skillLibraryDir(), dshVersions: dshVersionDir() }
}

/** The state the settings page renders. Legacy paths are filtered to those
 * still on disk, so a warning disappears once the user clears the old dir. */
function dataRootState(): DataRootState {
  return {
    configured: configuredDataRoot() ?? '',
    effective: dataRoot(),
    derived: {
      plugins: pluginDir(),
      skillLibrary: skillLibraryDir(),
      dshVersions: dshVersionDir(),
    },
    legacy: legacyDirOverrides().filter(o => existsSync(o.path)),
  }
}

/** Why a relocation must not start right now. A dsh executable or a home being
 * copied while a child process is using it is a hard error, not a slow one. */
function moveBlockers(): string[] {
  const busy = listRuns().length > 0 || listPluginDownloads().some(d => d.status === 'running')
  return busy ? [E.dataRootBusy] : []
}

/** Whether two paths overlap — equal, or one inside the other. A root nested in
 * one of its own sources would make the copy read the tree it is writing. */
function overlaps(a: string, b: string): boolean {
  const ra = resolve(a)
  const rb = resolve(b)
  return ra === rb || ra.startsWith(rb + sep) || rb.startsWith(ra + sep)
}

/** Validate + apply a root. An empty string resets to the default and touches
 * no file. With `migrate`, the dirs are copied first and the settings are
 * switched ONLY when every requested item landed and verified — a partial
 * failure leaves the app exactly where it started and reports what went wrong. */
export async function applyDataRoot(
  dir: string,
  opts: { migrate?: boolean; items?: DataRootItemKey[] } = {},
): Promise<IpcResult<DataRootApplyResult>> {
  const trimmed = dir.trim()

  if (trimmed === '') {
    patchSettings({ dataRoot: undefined })
    flushSettings()
    return { ok: true, value: { effective: dataRoot(), applied: true, moved: [], failed: [] } }
  }

  const target = resolve(trimmed)
  try {
    if (existsSync(target) && !statSync(target).isDirectory()) {
      return fail(E.storeNotDir, { path: target })
    }
    mkdirSync(target, { recursive: true })
    // The same write probe the plugin store uses: the root has to be usable
    // before anything is copied into it.
    const probe = join(target, '.pm-write-probe')
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
  } catch (error) {
    return fail(E.storeUnusable, { detail: String(error) })
  }

  const sources = currentSources()
  for (const key of ITEM_KEYS) {
    if (overlaps(target, sources[key])) return fail(E.dataRootNested, { path: target, source: sources[key] })
  }

  const keys = opts.items ?? ITEM_KEYS
  let moved: DataRootMoveResult[] = []

  if (opts.migrate === true) {
    if (moveBlockers().length > 0) return fail(E.dataRootBusy)

    const outcome = await moveDataRoot(planDataRootMove(sources, target), keys)
    if (outcome.failed.length > 0) {
      // The settings stay on the OLD root: a root is only ever pointed at once
      // every requested item is there AND verified.
      return {
        ok: true,
        value: { effective: dataRoot(), applied: false, moved: outcome.results, failed: outcome.failed },
      }
    }
    // Rewrite the registry before the root is switched, so the next `dsh:list`
    // scan can never see the old execPath and re-register it as a second entry.
    if (outcome.remap.length > 0) updateDshState(entries => remapDshEntries(entries, outcome.remap))
    moved = outcome.results
  }

  // Make `<root>/plugins` usable BEFORE the settings switch: a bad pre-existing
  // manifest there must fail the whole call rather than leave the app pointing
  // at a store it cannot open.
  const store = join(target, 'plugins')
  const ensured = ensurePluginStore(store)
  if (!ensured.ok) return fail(ensured.code, ensured.params)

  patchSettings({ dataRoot: target })
  flushSettings()
  // Fire-and-forget, exactly as at startup: a clean store is a read-only no-op.
  repairArchiveLinks(store).catch(error => logger.warn(`store relink failed: ${String(error)}`))
  return { ok: true, value: { effective: target, applied: true, moved, failed: [] } }
}

export function registerDataRootIpc(): void {
  handle('settings:getDataRoot', (): IpcResult<DataRootState> => ({ ok: true, value: dataRootState() }))

  // Read-only: safe to call while the user types a path. `blockers` is reported
  // rather than thrown, so the dialog can explain why the move is unavailable
  // instead of failing on confirm.
  handle('settings:previewDataRoot', (_event, dir: string): IpcResult<DataRootPlan> => {
    const trimmed = (dir ?? '').trim()
    if (trimmed === '') return fail(E.nameInvalid)
    return {
      ok: true,
      value: { ...planDataRootMove(currentSources(), resolve(trimmed)), blockers: moveBlockers() },
    }
  })

  handle('settings:applyDataRoot', (
    _event, dir: string, opts?: { migrate?: boolean; items?: DataRootItemKey[] },
  ): Promise<IpcResult<DataRootApplyResult>> => applyDataRoot(dir, opts ?? {}))
}
