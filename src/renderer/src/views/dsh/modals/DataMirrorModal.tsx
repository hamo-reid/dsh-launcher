/**
 * Mirror one dsh's data into another's home: copy the migratable file set, with
 * the cross-major gate and the force override.
 */
import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Modal, Select, Space, message, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../../lib/ipc.ts'
import { majorOfVersion } from '../../../../../shared/version.ts'
import { MODAL } from '../../../theme.ts'
import type { DshDataImportResult } from '../../../../../shared/types.ts'

// ── Data mirror (migrate a dsh's data to another dsh's home) ────────────────

interface DataMirrorModalProps {
  open: boolean
  /** The source dsh (whose data migrates); `null` hides the modal. */
  source: { id: string; name: string; version: string } | null
  onClose: () => void
  onDone: () => void | Promise<void>
}
export function DataMirrorModal(p: DataMirrorModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [targets, setTargets] = useState<{ id: string; name: string; version: string }[]>([])
  const [targetId, setTargetId] = useState<string>()
  const [ackCross, setAckCross] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<DshDataImportResult | null>(null)

  useEffect(() => {
    if (!p.open) return
    setTargets([]); setTargetId(undefined); setAckCross(false); setBusy(false); setError(''); setResult(null)
    void (async () => {
      const r = await window.api.dsh.list()
      if (r.ok) setTargets(r.value.dshes.filter(d => d.id !== p.source?.id))
    })()
  }, [p.open])

  const target = targets.find(d => d.id === targetId)
  const crossMajor = target !== undefined && p.source !== null
    && majorOfVersion(target.version) !== -1 && majorOfVersion(p.source.version) !== -1
    && majorOfVersion(target.version) !== majorOfVersion(p.source.version)

  const doMirror = async (): Promise<void> => {
    if (p.source === null || targetId === undefined) { void message.warning(t('data.mirror.noTarget')); return }
    if (crossMajor && !ackCross) return
    setBusy(true); setError('')
    try {
      const r = await window.api.data.mirror(p.source.id, targetId)
      if (!r.ok) { setError(apiErrorText(r)); return }
      setResult(r.value)
      void message.success(t('data.mirror.done'))
      await p.onDone()
    } finally {
      setBusy(false)
    }
  }

  const footer = busy
    ? <Space><Button loading>{t('data.mirror.running')}</Button></Space>
    : result !== null
      ? <Button type="primary" onClick={p.onClose}>{t('common.close')}</Button>
      : (
        <Space>
          <Button onClick={p.onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button type="primary" disabled={targetId === undefined || (crossMajor && !ackCross)} onClick={() => void doMirror()}>
            {t('data.mirror.start')}
          </Button>
        </Space>
      )

  return (
    <Modal title={t('data.mirror.title', { name: p.source?.name ?? '' })} open={p.open}
      onCancel={busy ? undefined : p.onClose} closable={!busy} mask={{ closable: !busy }}
      width={MODAL.narrow} footer={footer}>
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        {result === null && (
          <>
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
              {t('data.mirror.prompt')}
            </div>
            <Select
              style={{ width: '100%' }} showSearch optionFilterProp="label"
              placeholder={t('data.mirror.targetPlaceholder')}
              value={targetId} onChange={v => { setTargetId(v); setAckCross(false) }}
              options={targets.map(d => ({ value: d.id, label: d.name }))}
            />
            {crossMajor && (
              <>
                <Alert type="warning" showIcon title={t('data.mirror.crossMajor')} />
                <Checkbox checked={ackCross} onChange={e => setAckCross(e.target.checked)}>
                  {t('data.mirror.ack')}
                </Checkbox>
              </>
            )}
          </>
        )}

        {error !== '' && <Alert type="error" showIcon title={error} />}
        {result !== null && (
          <Alert type="success" showIcon title={t('data.mirror.done')} description={result.text} />
        )}
      </Space>
    </Modal>
  )
}

