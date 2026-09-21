/**
 * Attach a dev package to a profile: a live `link:` (dev) or a copy of its build
 * output into the profile's store (stable).
 *
 * The choice is local to this dialog — which dsh, which of its profiles, which
 * mode — so it lives here and resets every time the dialog is opened for a
 * package, rather than being reset by the caller at open time.
 */
import { useEffect, useState } from 'react'
import { Modal, Radio, Select, Space, theme, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../../lib/ipc.ts'
import FieldLabel from '../../../components/FieldLabel.tsx'
import { MODAL } from '../../../theme.ts'
import type { DevLinkMode, DevPlugin } from '../../../../../shared/types.ts'

interface Props {
  /** The package to attach; the dialog is open while this is set. */
  pkg: DevPlugin | null
  onClose: () => void
  /** Called after a successful link, so the list and the badges can reload. */
  onLinked: () => Promise<void>
}

export default function DevLinkModal({ pkg, onClose, onLinked }: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [scopes, setScopes] = useState<{ id: string; name: string; profiles: string[] }[]>([])
  const [dshId, setDshId] = useState<string>()
  const [profile, setProfile] = useState<string>()
  const [mode, setMode] = useState<DevLinkMode>('link')
  const [linking, setLinking] = useState(false)

  // Opening for a package starts a fresh choice: the last one's dsh may not be
  // installed any more, and its profile certainly is not this package's.
  useEffect(() => {
    if (pkg === null) return
    setMode('link')
    setProfile(undefined)
    void (async () => {
      const r = await window.api.plugins.installOptions()
      if (!r.ok) return
      setScopes(r.value)
      setDshId(prev => (prev !== undefined && r.value.some(s => s.id === prev)) ? prev : r.value[0]?.id)
    })()
  }, [pkg])

  const doLink = async (): Promise<void> => {
    if (pkg === null || dshId === undefined || profile === undefined) return
    setLinking(true)
    const r = await window.api.plugins.devLinkToProfile(dshId, profile, pkg.name, mode)
    setLinking(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(r.value)
    onClose()
    await onLinked()
  }

  return (
    <Modal
      title={t('plugin.dev.linkTitle', { name: pkg?.name ?? '' })}
      open={pkg !== null}
      onCancel={onClose}
      onOk={() => void doLink()}
      confirmLoading={linking}
      okButtonProps={{ disabled: dshId === undefined || profile === undefined }}
      width={MODAL.narrow}
    >
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <div>
          <FieldLabel>{t('plugin.dev.linkDsh')}</FieldLabel>
          <Select
            style={{ width: '100%' }}
            value={dshId}
            onChange={v => { setDshId(v); setProfile(undefined) }}
            options={scopes.map(s => ({ value: s.id, label: s.name }))}
          />
        </div>
        <div>
          <FieldLabel>{t('plugin.dev.linkProfile')}</FieldLabel>
          <Select
            style={{ width: '100%' }}
            value={profile}
            onChange={setProfile}
            disabled={dshId === undefined}
            options={(scopes.find(s => s.id === dshId)?.profiles ?? []).map(p => ({ value: p, label: p }))}
          />
        </div>
        <div>
          <FieldLabel>{t('plugin.dev.linkMode')}</FieldLabel>
          <Radio.Group value={mode} onChange={e => setMode(e.target.value as DevLinkMode)}>
            <Radio.Button value="link">{t('plugin.dev.linkModeLink')}</Radio.Button>
            <Radio.Button value="copy">{t('plugin.dev.linkModeCopy')}</Radio.Button>
          </Radio.Group>
          <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: 4 }}>{t('plugin.dev.linkModeHint')}</div>
        </div>
      </Space>
    </Modal>
  )
}
