/**
 * The install view: a network source (npm / git spec) fired as a cancellable
 * download session, and a local `.zip` picker.
 *
 * The two drafts and the log are private to this view; the textarea is the only
 * shared thing, so the owner is told when a local install landed and refreshes the
 * overview and the in-store tags itself.
 */
import { useState } from 'react'
import { Alert, Button, Input, Space, theme, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../lib/ipc.ts'
import Panel from '../../components/Panel.tsx'
import SectionHeading from '../../components/SectionHeading.tsx'

interface Props {
  /** The plugin store dir, shown on the download button. */
  dir: string
  dirMissing: boolean
  /** A local install landed — the owner refreshes the overview and in-store tags. */
  onInstalled: () => Promise<void> | void
}

export default function PluginsInstallView({ dir, dirMissing, onInstalled }: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [source, setSource] = useState('')
  /** Which action is running, so only that button spins and the rest disable. */
  const [busyAction, setBusyAction] = useState<null | 'network' | 'zip'>(null)
  const [log, setLog] = useState('')

  const install = (): void => {
    const spec = source.trim()
    if (spec === '') return
    setLog('')
    // Fire a cancellable download session; progress and cancel live in the global
    // download panel. Store tags refresh when any session settles.
    void window.api.downloads.start(spec)
    void message.info(t('plugin.download.started'))
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

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size="middle">
      <SectionHeading title={t('plugin.installSection.title')} />
      {dirMissing
        ? <Alert type="warning" showIcon title={t('plugin.dirMissing')} />
        : <Alert type="info" showIcon title={t('plugin.installSection.info')} />}

      <Panel title={t('plugin.installSection.network')}>
        <Input value={source} onChange={event => setSource(event.target.value)} placeholder={t('plugin.installSection.sourcePlaceholder')} style={{ maxWidth: 480 }} />
        <div style={{ marginTop: token.paddingSM }}>
          <Button type="primary" onClick={install} loading={busyAction === 'network'} disabled={source.trim() === '' || dirMissing || busyAction !== null}>
            {dir !== '' ? t('plugin.installSection.downloadDir', { dir }) : t('plugin.installSection.download')}
          </Button>
        </div>
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
