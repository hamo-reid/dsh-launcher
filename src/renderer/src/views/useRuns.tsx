/** Owns the multi-run coordination for the Run page: the live run list, per-run
 * console buffers, start/stop and failure surfacing. Replaces the single-run
 * `useRunRuntime` (which assumed at most one process). */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal, message, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import type { InsertConflict, LaunchOptions, RunInfo, RunMode } from '../../../shared/types.ts'

export interface RunFailInfo {
  code: number | null
  signal: string | null
  command?: string
  /** Buffered output of the failed run (for the failure dialog). */
  logs: string
  eaddrinuse: RegExpExecArray | null
}

/** A launch refused because the profile's composed layers insert the same loader
 * entry id more than once (the host would fail with a duplicate-id error). */
export interface RunConflictInfo {
  profile: string
  conflicts: InsertConflict[]
}

/** Per-run console buffer cap, mirroring the main process' `RUN_LOG_CAP`. */
const LOG_CAP = 512 * 1024

export interface UseRuns {
  /** Live runs, newest last. */
  running: RunInfo[]
  /** Runs that ended during this renderer session (kept so their output stays
   * readable); cleared on renderer reload. */
  exited: RunInfo[]
  selectedId: string | null
  selected: RunInfo | undefined
  select: (id: string) => void
  /** Buffered console output for one run. */
  logsOf: (id: string) => string
  start: (profile: string, mode: RunMode | undefined, options: LaunchOptions | undefined, dshId: string, select?: boolean) => Promise<boolean>
  /** Relaunch an exited run with its own dsh + mode and saved parameters. */
  restart: (run: RunInfo) => Promise<void>
  /** Return to the launcher view (no run selected). */
  deselect: () => void
  stop: (id: string) => Promise<void>
  stopAll: () => Promise<void>
  clearExited: (id: string) => void
  openUrl: (url: string) => void
  failInfo: RunFailInfo | null
  clearFail: () => void
  /** Set when a launch was refused for duplicate inserted entry ids. */
  conflictInfo: RunConflictInfo | null
  clearConflict: () => void
}

/** Friendly hint when the captured output shows a port collision. */
function eaddrinuseFrom(logs: string): RegExpExecArray | null {
  return /EADDRINUSE[^\d]*(\d{1,3}(?:\.\d{1,3}){3}):(\d+)/.exec(logs)
}

export function useRuns(): UseRuns {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [running, setRunning] = useState<RunInfo[]>([])
  const [exited, setExited] = useState<RunInfo[]>([])
  const [logs, setLogs] = useState<Record<string, string>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [failInfo, setFailInfo] = useState<RunFailInfo | null>(null)
  const [conflictInfo, setConflictInfo] = useState<RunConflictInfo | null>(null)

  // Latest buffers, readable from the event callback without re-subscribing.
  const logsRef = useRef<Record<string, string>>({})
  useEffect(() => { logsRef.current = logs }, [logs])

  const appendLog = useCallback((id: string, line: string): void => {
    setLogs(prev => {
      const next = (prev[id] ?? '') + line
      return { ...prev, [id]: next.length > LOG_CAP ? next.slice(-LOG_CAP) : next }
    })
  }, [])

  // Restore live runs after a renderer reload (the processes keep running in
  // main); their consoles are fetched lazily on selection.
  useEffect(() => {
    let alive = true
    void window.api.run.list().then(result => {
      if (!alive) return
      if (!result.ok) { void message.error(apiErrorText(result)); return }
      setRunning(result.value)
      setSelectedId(prev => prev ?? result.value[0]?.id ?? null)
    })
    return () => { alive = false }
  }, [])

  // Stream runtime events, demultiplexed by run id.
  useEffect(() => {
    return window.api.run.onEvent(event => {
      if (event.type === 'started') {
        setRunning(prev => prev.some(r => r.id === event.run.id) ? prev : [...prev, event.run])
        setSelectedId(prev => prev ?? event.run.id)
        return
      }
      if (event.type === 'output') {
        appendLog(event.id, event.line)
        return
      }
      // exited: move out of the live list, keep the entry for output review.
      const run = event.run
      setRunning(prev => prev.filter(r => r.id !== run.id))
      setExited(prev => prev.some(r => r.id === run.id) ? prev : [...prev, run])
      const failed = run.code !== 0 || run.signal !== null
      if (failed) {
        const text = logsRef.current[run.id] ?? ''
        setFailInfo({ code: run.code ?? null, signal: run.signal ?? null, command: run.command, logs: text, eaddrinuse: eaddrinuseFrom(text) })
        void message.error(t('run.launchFailed'))
      }
    })
  }, [appendLog, t])

  // Lazily pull a run's buffered output the first time it is shown (e.g. after
  // a reload, or when selecting a restored run).
  useEffect(() => {
    if (selectedId === null) return
    if (logsRef.current[selectedId] !== undefined) return
    let alive = true
    void window.api.run.logs(selectedId).then(result => {
      if (alive && result.ok && result.value !== '') setLogs(prev => ({ ...prev, [selectedId]: result.value }))
    })
    return () => { alive = false }
  }, [selectedId])

  const start = async (profile: string, mode: RunMode | undefined, options: LaunchOptions | undefined, dshId: string, select = true): Promise<boolean> => {
    if (profile.trim() === '') return false
    const result = await window.api.run.start(profile, mode, options, dshId)
    if (!result.ok) {
      // A duplicate-insert-id refusal gets a structured modal (bundles + plugin
      // ids); every other failure stays a toast.
      if (result.code === 'run.insertConflict' && result.conflicts !== undefined) {
        setConflictInfo({ profile, conflicts: result.conflicts })
      } else {
        void message.error(apiErrorText(result))
      }
      return false
    }
    // The 'started' event adds it to the list; clear any stale buffer.
    setLogs(prev => ({ ...prev, [result.value.id]: '' }))
    // Quick launch keeps the launcher visible (so several can be started in a
    // row); the new run still appears in the rail and turns its tile to 运行中.
    if (select) setSelectedId(result.value.id)
    if (mode === 'shell') void message.success(t('run.openedShell', { profile }))
    return true
  }

  // Relaunch an exited run: explicit dsh + mode, saved options reused.
  const restart = async (run: RunInfo): Promise<void> => {
    await start(run.profile, run.mode, undefined, run.dshId)
  }

  /** Return to the launcher: clear the selection so the quick-launch view shows. */
  const deselect = (): void => setSelectedId(null)

  const stop = async (id: string): Promise<void> => {
    const result = await window.api.run.stop(id)
    if (!result.ok) void message.error(apiErrorText(result))
  }

  const stopAll = async (): Promise<void> => {
    await Promise.all(running.map(run => window.api.run.stop(run.id)))
  }

  const clearExited = (id: string): void => {
    setExited(prev => prev.filter(r => r.id !== id))
    setLogs(prev => {
      if (prev[id] === undefined) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const selected = [...running, ...exited].find(r => r.id === selectedId)
  const logsOf = (id: string): string => logs[id] ?? ''

  // Intercept a console URL: ask first, then open with the default handler.
  const openUrl = (url: string): void => {
    Modal.confirm({
      title: t('run.openUrlTitle'),
      content: (
        <div>
          {t('run.openUrlPrompt')}
          <div style={{ wordBreak: 'break-all', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM, color: token.colorTextSecondary, marginTop: token.paddingSM }}>
            {url}
          </div>
        </div>
      ),
      okText: t('run.open'),
      onOk: async () => {
        const result = await window.api.run.openExternal(url)
        if (!result.ok) void message.error(apiErrorText(result))
      },
    })
  }

  const clearFail = (): void => setFailInfo(null)

  const clearConflict = (): void => setConflictInfo(null)

  return {
    running, exited, selectedId, selected, select: setSelectedId, logsOf,
    start, stop, stopAll, restart, deselect, clearExited, openUrl, failInfo, clearFail,
    conflictInfo, clearConflict,
  }
}
