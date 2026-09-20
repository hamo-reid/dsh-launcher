import { useCallback, useEffect, useState } from 'react'
import type { DownloadSessionInfo, IpcResult } from '../../../shared/types.ts'

/** Start a background dsh install/update session (returns its session id). */
export type StartDshArgs =
  | { op: 'install'; versionDir?: string; name?: string; version?: string; force?: boolean }
  | { op: 'update'; id: string; version?: string; ackMajorRisk?: boolean }

/**
 * Global download-center state: both plugin and dsh sessions. Live rows come from
 * `download:change` pushes; a settled session is dropped from that live list, so
 * its terminal state arrives once via `download:settled`. The FAILED/cancelled
 * ones are retained here — a download that fails must not vanish without a trace
 * — while successes need no record (a later success also clears its stale
 * failure). Exposes the full row list split by kind, plus idempotent
 * `start*`/`cancel`/`dismiss`/`cleanup` wrappers for the shared download panel.
 */
export function useDownloads(): {
  downloads: DownloadSessionInfo[]
  dshDownloads: DownloadSessionInfo[]
  pluginDownloads: DownloadSessionInfo[]
  startPlugin: (source: string, name?: string) => Promise<IpcResult<{ id: string }>>
  startDsh: (args: StartDshArgs) => Promise<IpcResult<{ id: string }>>
  cancel: (id: string) => Promise<void>
  dismiss: (id: string) => void
  cleanup: () => Promise<string[]>
} {
  const [live, setLive] = useState<DownloadSessionInfo[]>([])
  const [settled, setSettled] = useState<DownloadSessionInfo[]>([])

  useEffect(() => {
    let alive = true
    void window.api.downloads.list().then(r => { if (alive && r.ok) setLive(r.value) })
    const offChange = window.api.downloads.onChange(setLive)
    const offSettled = window.api.downloads.onSettled(s => {
      // Keep at most one retained terminal row per kind (the newest).
      setSettled(prev => {
        const kept = prev.filter(x => x.kind !== s.kind)
        return s.status === 'done' ? kept : [...kept, s]
      })
    })
    return () => { alive = false; offChange(); offSettled() }
  }, [])

  // Live rows first; retained failures follow (one per kind at most).
  const downloads = [...live, ...settled]
  const dshDownloads = downloads.filter(d => d.kind === 'dsh')
  const pluginDownloads = downloads.filter(d => d.kind === 'plugin')

  const startPlugin = useCallback(
    (source: string, name?: string): Promise<IpcResult<{ id: string }>> =>
      window.api.downloads.start(source, name),
    [],
  )

  const startDsh = useCallback((args: StartDshArgs): Promise<IpcResult<{ id: string }>> => {
    if (args.op === 'install') return window.api.dsh.installOfficial(args)
    return window.api.dsh.update(args.id, args)
  }, [])

  const cancel = useCallback(async (id: string): Promise<void> => {
    await window.api.downloads.cancel(id)
  }, [])

  const dismiss = useCallback((id: string): void => {
    setSettled(prev => prev.filter(x => x.id !== id))
  }, [])

  const cleanup = useCallback(async (): Promise<string[]> => {
    const r = await window.api.downloads.cleanup()
    return r.ok ? r.value.removed : []
  }, [])

  return { downloads, dshDownloads, pluginDownloads, startPlugin, startDsh, cancel, dismiss, cleanup }
}

export type UseDownloads = ReturnType<typeof useDownloads>
