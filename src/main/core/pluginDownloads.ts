/**
 * Plugin download session manager. Every user-visible download (download center,
 * market, install view) runs as one cancellable session tracked here: a session
 * owns an AbortController whose signal flows all the way into `runPnpm` (kills
 * the pnpm child tree), and `installSource` cleans its own `.staging` on cancel.
 *
 * The renderer's global download panel reads `listPluginDownloads()` and is kept
 * up to date via `onDownloadsChange`. Sessions are removed once they reach a
 * terminal state, so the panel shows live work only (plus a cleanup affordance
 * for any half-written staging/import leftovers).
 *
 * Because a settled session leaves the live list, its terminal state is
 * delivered exactly once through `onDownloadsSettled` — that is the only way a
 * consumer can observe completion, and the reason a failure is reported instead
 * of silently vanishing.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { deleteTreePhysical, installSource, packageNameFromSource } from './plugins.ts'
import { logger } from './logger.ts'
import type { DownloadKind, DownloadSessionInfo, DownloadStep } from '../../shared/types.ts'

export type DownloadStatus = DownloadSessionInfo['status']

interface DownloadSession {
  id: string
  kind: DownloadKind
  name: string
  source: string
  detail?: string
  status: DownloadStatus
  message?: string
  steps: DownloadStep[]
  /** Cancellation signal — present only for cancellable (plugin) sessions. */
  controller?: AbortController
}

/** Live sessions by id. Kept only while installing; removed on completion. */
const active = new Map<string, DownloadSession>()
let seq = 0
let emit: ((list: DownloadSessionInfo[]) => void) | undefined
let emitSettled: ((session: DownloadSessionInfo) => void) | undefined

/** Register the listener that pushes session snapshots (the IPC layer wires this
 * to `webContents.send('download:change', …)`). */
export function onDownloadsChange(fn: (list: DownloadSessionInfo[]) => void): void {
  emit = fn
}

/** Register the listener notified once per session when it reaches a terminal
 * state, right after it leaves the live list. The live snapshot deliberately
 * drops settled sessions, so this is the sole completion signal — without it a
 * finished download (a FAILED one above all) would vanish without a trace. */
export function onDownloadsSettled(fn: (session: DownloadSessionInfo) => void): void {
  emitSettled = fn
}

function toInfo({ id, kind, name, source, detail, status, message, steps }: DownloadSession): DownloadSessionInfo {
  return { id, kind, name, source, detail, status, message, steps }
}

function snapshot(): DownloadSessionInfo[] {
  return [...active.values()].map(toInfo)
}

function notify(): void {
  emit?.(snapshot())
}

/** Current live download sessions (by insertion order). */
export function listPluginDownloads(): DownloadSessionInfo[] {
  return snapshot()
}

/** Kick off a cancellable download of `source` into the store. Resolves with the
 * session id; the async work lands a status update + change notification. */
export function startPluginDownload(storeDir: string, source: string, name?: string): string {
  const installName = (name ?? packageNameFromSource(source)).trim()
  const id = `dl-${++seq}`
  const controller = new AbortController()
  const session: DownloadSession = {
    id,
    kind: 'plugin',
    name: installName === '' ? source : installName,
    source,
    detail: source,
    status: 'running',
    steps: [],
    controller,
  }
  active.set(id, session)
  notify()

  void (async () => {
    try {
      const res = await installSource(storeDir, installName === '' ? source : installName, source, controller.signal)
      if (controller.signal.aborted) { session.status = 'cancelled'; session.message = 'cancelled' }
      else if (res.ok) { session.status = 'done'; session.message = res.text }
      else { session.status = 'failed'; session.message = res.text }
    } catch (error) {
      session.status = 'failed'
      session.message = error instanceof Error ? error.message : String(error)
    } finally {
      active.delete(id)
      notify()
      emitSettled?.(toInfo(session))
      logger.info(`plugin download ${session.name}: ${session.status}`)
    }
  })()

  return id
}

/** Start a background dsh install/update session. Resolves with the session id;
 * `job` receives a `patchStep` that upserts one progress step and broadcasts the
 * snapshot, so the global download center tracks the dsh install live. Success is
 * signalled by `job` resolving; a thrown error surfaces as a `failed` session
 * (dsh upgrades are not cancellable today, so no AbortController is wired). */
export function startDshDownload(
  name: string,
  detail: string,
  job: (patchStep: (step: DownloadStep) => void) => Promise<void>,
): string {
  const id = `dl-${++seq}`
  const steps: DownloadStep[] = []
  const session: DownloadSession = {
    id,
    kind: 'dsh',
    name,
    source: '',
    detail,
    status: 'running',
    steps,
  }
  active.set(id, session)
  notify()

  const patchStep = (step: DownloadStep): void => {
    const at = steps.findIndex(s => s.key === step.key)
    if (at >= 0) steps[at] = step
    else steps.push(step)
    notify()
  }

  void (async () => {
    try {
      await job(patchStep)
      session.status = 'done'
    } catch (error) {
      session.status = 'failed'
      session.message = error instanceof Error ? error.message : String(error)
    } finally {
      active.delete(id)
      notify()
      emitSettled?.(toInfo(session))
      logger.info(`dsh install ${session.name}: ${session.status}`)
    }
  })()

  return id
}

/** Cancel a running download. No-op when the session is unknown, already done, or
 * not cancellable (dsh sessions have no AbortController). */
export function cancelPluginDownload(id: string): boolean {
  const session = active.get(id)
  if (session === undefined) return false
  if (session.status !== 'running') return false
  if (session.controller === undefined) return false
  session.controller.abort()
  return true
}

/**
 * Remove half-written download leftovers: every `archive/<name>/.staging` (an
 * interrupted pnpm project) and the zip-extract dir `store/.import`. Returns the
 * paths that were cleaned. Routing stays garbage-safe: nested `.staging` dirs
 * that are newly-created mid-scan are left for the next pass.
 */
export function cleanupPluginDownloads(storeDir: string): { removed: string[] } {
  const removed: string[] = []
  const arc = join(storeDir, 'archive')
  if (existsSync(arc)) {
    for (const top of readdirSync(arc, { withFileTypes: true })) {
      if (!top.isDirectory() || top.name === '.staging') continue
      const scopeDir = join(arc, top.name)
      // Scoped plugins nest one level deeper: archive/@scope/<name>.
      const horizons = top.name.startsWith('@')
        ? readdirSync(scopeDir).filter(e => e !== '.staging').map(e => join(scopeDir, e))
        : [scopeDir]
      for (const h of horizons) {
        if (!existsSync(h)) continue
        const staging = join(h, '.staging')
        if (!existsSync(staging)) continue
        deleteTreePhysical(staging)
        removed.push(staging.replace(/\\/g, '/'))
      }
    }
  }
  const imp = join(storeDir, '.import')
  if (existsSync(imp)) {
    deleteTreePhysical(imp)
    removed.push(imp.replace(/\\/g, '/'))
  }
  return { removed }
}