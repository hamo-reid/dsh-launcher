import { useCallback, useEffect, useState } from 'react'
import type { DownloadSessionInfo, IpcResult } from '../../../shared/types.ts'

/** Start a background dsh install/update session (returns its session id). */
export type StartDshArgs =
  | { op: 'install'; versionDir?: string; name?: string; version?: string; force?: boolean }
  | { op: 'update'; id: string; version?: string; ackMajorRisk?: boolean }

/**
 * Global download-center state: both plugin and dsh sessions, kept live by
 * `download:change` pushes from the main process. Exposes the full session list
 * split by kind, plus idempotent `start*`/`cancel`/`cleanup` wrappers for the
 * shared download panel (a dsh install is a background session today, surfaced
 * from the DSH page dialogs via `startDsh`).
 */
export function useDownloads(): {
  downloads: DownloadSessionInfo[]
  dshDownloads: DownloadSessionInfo[]
  pluginDownloads: DownloadSessionInfo[]
  startPlugin: (source: string, name?: string) => Promise<IpcResult<{ id: string }>>
  startDsh: (args: StartDshArgs) => Promise<IpcResult<{ id: string }>>
  cancel: (id: string) => Promise<void>
  cleanup: () => Promise<string[]>
} {
  const [downloads, setDownloads] = useState<DownloadSessionInfo[]>([])

  // Mirror the main-process cursor so the panel only shows one terminal entry
  // state at a time (sessions are removed on completion server-side; the push
  // wholesale-replaces the list).
  useEffect(() => {
    let alive = true
    void window.api.downloads.list().then(r => { if (alive && r.ok) setDownloads(r.value) })
    const off = window.api.downloads.onChange(setDownloads)
    return () => { alive = false; off() }
  }, [])

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

  const cleanup = useCallback(async (): Promise<string[]> => {
    const r = await window.api.downloads.cleanup()
    return r.ok ? r.value.removed : []
  }, [])

  return { downloads, dshDownloads, pluginDownloads, startPlugin, startDsh, cancel, cleanup }
}

export type UseDownloads = ReturnType<typeof useDownloads>