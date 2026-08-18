/** Owns the embedded profile-runtime coordination (start / stop / console /
 * failure) for the Profile page. Extracted so `ProfileSection` stays focused on
 * list + CRUD orchestration. */

import { useEffect, useState } from 'react'
import { Modal, message, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'

export interface RunFailInfo {
  code: number | null
  signal: string | null
  command?: string
}

export interface UseRunRuntime {
  running: boolean
  runningProfile?: string
  shellLaunch: boolean
  setShellLaunch: (v: boolean) => void
  logs: string
  failInfo: RunFailInfo | null
  /** EADDRINUSE match on the captured logs (port collision hint), when present. */
  eaddrinuse: RegExpExecArray | null
  doLaunch: (profile: string) => Promise<void>
  doLaunchShell: (profile: string) => Promise<void>
  stopRun: () => Promise<void>
  /** Intercept a console URL: confirm, then open with the default handler. */
  openUrl: (url: string) => void
  /** Dismiss a surfaced launch-failure dialog. */
  clearFail: () => void
}

export function useRunRuntime(): UseRunRuntime {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [running, setRunning] = useState(false)
  const [runningProfile, setRunningProfile] = useState<string>()
  const [shellLaunch, setShellLaunch] = useState(false)
  const [logs, setLogs] = useState('')
  const [failInfo, setFailInfo] = useState<RunFailInfo | null>(null)

  // Restore a live run after a full renderer reload: the process keeps running in
  // main, so repaint the console from the buffered log and status.
  useEffect(() => {
    let alive = true
    void (async () => {
      const stateResult = await window.api.run.state()
      if (!alive) return
      if (!stateResult.ok || !stateResult.value.running) return
      const logsResult = await window.api.run.logs()
      if (!alive) return
      if (logsResult.ok) setLogs(logsResult.value)
      setRunningProfile(stateResult.value.profile)
      setRunning(true)
    })()
    return () => { alive = false }
  }, [])

  // Stream the embedded runtime: append output, react to exit.
  useEffect(() => {
    return window.api.run.onEvent(event => {
      if (event.type === 'output') {
        setLogs(prev => prev + event.line)
        return
      }
      setRunning(false)
      setRunningProfile(undefined)
      const failed = event.code !== 0 || event.signal !== null
      if (failed) {
        // Always resolve the launch command so the dialog can show exactly what
        // was attempted, even if it did not ride on the exited event.
        setFailInfo({ code: event.code, signal: event.signal, command: event.command })
        void window.api.run.command().then(result => {
          if (result.ok && result.value !== '') {
            setFailInfo(prev => prev === null ? prev : { ...prev, command: result.value })
          }
        })
        void message.error(t('run.launchFailed'))
      }
    })
  }, [])

  // App mode: launch `profile` into the embedded console.
  const doLaunch = async (profile: string): Promise<void> => {
    if (profile === '') return
    const result = await window.api.run.start(profile)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    setLogs('')
    setRunningProfile(profile)
    setRunning(true)
  }

  // System shell mode: attach to a visible OS terminal; app keeps process control
  // (abort + status) but shows no embedded console output.
  const doLaunchShell = async (profile: string): Promise<void> => {
    if (profile === '') return
    const result = await window.api.run.start(profile, 'shell')
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    setRunningProfile(profile)
    setRunning(true)
    void message.success(t('run.openedShell', { profile }))
  }

  const stopRun = async (): Promise<void> => {
    const result = await window.api.run.stop()
    if (!result.ok) { void message.error(apiErrorText(result)); return }
  }

  // Friendly hint when the captured output shows a port collision.
  const eaddrinuse = /EADDRINUSE[^\d]*(\d{1,3}(?:\.\d{1,3}){3}):(\d+)/.exec(logs)

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

  return {
    running, runningProfile, shellLaunch, setShellLaunch, logs, failInfo,
    eaddrinuse, doLaunch, doLaunchShell, stopRun, openUrl, clearFail,
  }
}