/**
 * The install view: a network source (npm / any git forge) fired as a cancellable
 * download session, and a local `.zip` picker.
 *
 * A network install is not a request/response — it is a pnpm run that streams for
 * a while — so this view reflects the session it started instead of firing and
 * forgetting: the live row for the source is shown inline, with the same status,
 * cancel and failure detail the download center has. The input clears and the
 * button spins while the session runs, because "nothing happened" is the one
 * thing a slow download must never look like.
 *
 * The local draft and the log are private to this view; both paths tell the owner
 * when an install landed so it can refresh the overview and in-store tags.
 */
import { useMemo, useState } from 'react'
import { Alert, Button, Input, Space, Tag, Typography, theme, message } from 'antd'
import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined, MinusCircleFilled } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../lib/ipc.ts'
import { useDownloads } from '../../hooks/useDownloads.ts'
import { summarizeSource, sameSource } from '../../lib/pluginSource.ts'
import Panel from '../../components/Panel.tsx'
import SectionHeading from '../../components/SectionHeading.tsx'
import FieldLabel from '../../components/FieldLabel.tsx'
import type { DownloadSessionInfo } from '../../../../shared/types.ts'

/** Display names for the git forges a shorthand can name. */
const FORGE_LABELS: Record<string, string | undefined> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gitea: 'Gitea',
  gitee: 'Gitee',
}

/** Status → its i18n key, so the union stays checkable at the call site. */
const STATUS_LABEL = {
  running: 'download.status.running',
  done: 'download.status.done',
  failed: 'download.status.failed',
  cancelled: 'download.status.cancelled',
} as const satisfies Record<DownloadSessionInfo['status'], string>

interface Props {
  /** The plugin store dir, shown on the download button. */
  dir: string
  dirMissing: boolean
  /** A local install landed — the owner refreshes the overview and in-store tags. */
  onInstalled: () => Promise<void> | void
}

/** The leading status glyph, matching the download center's vocabulary. */
function StatusIcon({ status }: { status: DownloadSessionInfo['status'] }): JSX.Element {
  const { token } = theme.useToken()
  if (status === 'running') return <LoadingOutlined spin style={{ fontSize: 16, color: token.colorWarning }} />
  if (status === 'done') return <CheckCircleFilled style={{ fontSize: 16, color: token.colorSuccess }} />
  if (status === 'failed') return <CloseCircleFilled style={{ fontSize: 16, color: token.colorError }} />
  return <MinusCircleFilled style={{ fontSize: 16, color: token.colorBorderSecondary }} />
}

export default function PluginsInstallView({ dir, dirMissing, onInstalled }: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { pluginDownloads, cancel } = useDownloads()
  const [source, setSource] = useState('')
  const [busyAction, setBusyAction] = useState<null | 'zip'>(null)
  const [log, setLog] = useState('')

  const trimmed = source.trim()
  const hint = useMemo(() => summarizeSource(trimmed), [trimmed])
  /** The one line that says what we read the draft as — the guess the user cannot
   * verify from the string alone (a repo whose package name differs from it). */
  const hintText = useMemo((): string | null => {
    if (trimmed === '' || hint === null) return null
    const forgeLabel = hint.kind === 'git' ? hint.host ?? 'git' : FORGE_LABELS[hint.kind]
    const parts: string[] = []
    if (hint.name === undefined) parts.push(t('plugin.installSection.detected.noName'))
    else if (forgeLabel === undefined) parts.push(t('plugin.installSection.detected.npm', { name: hint.name }))
    else parts.push(t('plugin.installSection.detected.forge', { forge: forgeLabel, repo: hint.repo ?? '—', name: hint.name }))
    if (hint.subpath !== undefined) parts.push(t('plugin.installSection.detected.subpath', { path: hint.subpath }))
    return parts.join(' · ')
  }, [trimmed, hint, t])
  /** A session for this exact source is already in flight. pnpm would happily run
   * two of them into the same staging dir, so this is refused, not merely hidden. */
  const inFlight = pluginDownloads.find(d => d.status === 'running' && sameSource(d.source, trimmed))

  const install = async (): Promise<void> => {
    if (trimmed === '' || inFlight !== undefined) return
    const result = await window.api.downloads.start(trimmed)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    // The source is now a session, not a draft: clear it so a second click cannot
    // re-submit the same spec by accident.
    setSource('')
    setLog('')
    void message.info(t('plugin.installSection.started'))
  }

  const addLocal = async (): Promise<void> => {
    setBusyAction('zip')
    const result = await window.api.plugins.addLocal()
    setBusyAction(null)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    setLog(result.value)
    void message.success(t('plugin.localAdded'))
    await onInstalled()
  }

  const renderSession = (d: DownloadSessionInfo): JSX.Element => (
    <div key={d.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0' }}>
      <span style={{ paddingTop: 2 }}><StatusIcon status={d.status} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Space size={8} wrap>
          <Typography.Text strong>{d.name}</Typography.Text>
          <Tag
            color={d.status === 'running' ? 'processing' : d.status === 'done' ? 'success' : d.status === 'failed' ? 'error' : 'default'}
            style={{ marginInlineEnd: 0 }}
          >
            {t(STATUS_LABEL[d.status])}
          </Tag>
        </Space>
        <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, wordBreak: 'break-all' }}>{d.source}</div>
        {d.status === 'failed' && d.message !== undefined && d.message !== '' && (
          <div style={{ color: token.colorError, fontSize: token.fontSizeSM, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{d.message}</div>
        )}
      </div>
      {d.status === 'running' && (
        <Button size="small" danger type="text" onClick={() => void cancel(d.id)}>{t('download.panel.cancel')}</Button>
      )}
    </div>
  )

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size="middle">
      <SectionHeading title={t('plugin.installSection.title')} />
      {dirMissing
        ? <Alert type="warning" showIcon title={t('plugin.dirMissing')} />
        : <Alert type="info" showIcon title={t('plugin.installSection.info')} />}

      <Panel title={t('plugin.installSection.network')}>
        <Space orientation="vertical" style={{ width: '100%' }} size="small">
          <Input
            value={source}
            onChange={event => setSource(event.target.value)}
            onPressEnter={() => void install()}
            placeholder={t('plugin.installSection.sourcePlaceholder')}
            style={{ maxWidth: 520 }}
            allowClear
          />
          {/* What we read the spec as, before anything is downloaded: the guess is
              the one thing the user cannot verify from the string alone. */}
          {hintText !== null && (
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>{hintText}</div>
          )}
          {/* One button, three states: nothing typed, THIS source already in
              flight, or ready. An unrelated download running does not block a new
              one — parallel downloads are the point of the session model — so only
              a duplicate submission is refused. */}
          <Button
            type="primary"
            onClick={() => void install()}
            loading={inFlight !== undefined}
            disabled={dirMissing || trimmed === '' || inFlight !== undefined}
          >
            {dir !== '' ? t('plugin.installSection.downloadDir', { dir }) : t('plugin.installSection.download')}
          </Button>

          {pluginDownloads.length > 0 && (
            <div style={{ marginTop: token.paddingXS, borderTop: `1px solid ${token.colorSplit}`, paddingTop: token.paddingSM }}>
              <FieldLabel>{t('plugin.installSection.sessions')}</FieldLabel>
              {pluginDownloads.map(renderSession)}
            </div>
          )}
        </Space>
      </Panel>

      <Panel title={t('plugin.installSection.local')}>
        <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginBottom: token.paddingSM }}>
          {t('plugin.installSection.localHint')}
        </div>
        <Space>
          <Button onClick={() => void addLocal()} loading={busyAction === 'zip'} disabled={dirMissing || busyAction !== null}>{t('plugin.installSection.fromZip')}</Button>
        </Space>
      </Panel>

      {log !== '' && (
        <pre style={{ background: token.colorFillTertiary, padding: token.paddingSM, borderRadius: token.borderRadius, maxHeight: 320, overflowY: 'auto', margin: 0 }}>{log}</pre>
      )}
    </Space>
  )
}
