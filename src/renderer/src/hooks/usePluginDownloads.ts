import { useCallback, useEffect, useRef, useState } from 'react'
import type { DownloadSessionInfo } from '../../../shared/types.ts'

/**
 * Global plugin-download state: initial snapshot from `downloads:list`, kept live
 * by `downloads:change` pushes from the main process. Exposes the session list +
 * idempotent `start`/`cancel`/`cleanup` wrappers for the shared download panel.
 */
export function usePluginDownloads(): {
  downloads: DownloadSessionInfo[]
  start: (source: string, name?: string) => Promise<void>
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
    const off = window.api.downloads.onChange(list => setDownloads(list))
    return () => { alive = false; off() }
  }, [])

  const start = useCallback(async (source: string, name?: string): Promise<void> => {
    await window.api.downloads.start(source, name)
  }, [])

  const cancel = useCallback(async (id: string): Promise<void> => {
    await window.api.downloads.cancel(id)
  }, [])

  const cleanup = useCallback(async (): Promise<string[]> => {
    const r = await window.api.downloads.cleanup()
    return r.ok ? r.value.removed : []
  }, [])

  return { downloads, start, cancel, cleanup }
}

export type UsePluginDownloads = ReturnType<typeof usePluginDownloads>