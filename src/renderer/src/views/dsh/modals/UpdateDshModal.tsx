/**
 * Upgrade a managed dsh in place, with the cross-major warning a version jump of
 * that size needs (the data layers are version-gated by dsh itself).
 */
import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Modal, Space, Spin, Tag, message, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../../lib/ipc.ts'
import { MODAL } from '../../../theme.ts'
import type { DshUpdateInfo } from '../../../../../shared/types.ts'

// ── Update (in-place version upgrade of a managed dsh) ───────────────────────

interface UpdateDshModalProps {
  /** The managed dsh to update; `null` hides the modal. */
  dsh: { id: string; name: string } | null
  onClose: () => void
  onDone: () => void | Promise<void>
}
export function UpdateDshModal(p: UpdateDshModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [info, setInfo] = useState<DshUpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [ackMajor, setAckMajor] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (p.dsh === null) return
    setInfo(null); setChecking(true); setAckMajor(false); setError('')
    let alive = true
    void (async () => {
      const r = await window.api.dsh.checkUpdate(p.dsh!.id)
      if (!alive) return
      setChecking(false)
      if (r.ok) setInfo(r.value)
      else setError(apiErrorText(r))
    })()
    return () => { alive = false }
  }, [p.dsh?.id])

  // Kicks off a **background** dsh download session and closes immediately; the
  // global download center tracks progress and refresh (not this dialog).
  const doUpdate = async (version: string): Promise<void> => {
    if (p.dsh === null) return
    const r = await window.api.dsh.update(p.dsh.id, { version, ackMajorRisk: ackMajor })
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('dsh.update.started'))
    p.onClose()
    await p.onDone()
  }

  // The update tracks offered (oldest → newest): `latest` stable and/or `next`
  // prerelease, each with its own button + major-bump gate.
  const tracks = info === null
    ? []
    : [
        ...(info.latest !== undefined ? [{ key: 'latest' as const, ...info.latest }] : []),
        ...(info.next !== undefined ? [{ key: 'next' as const, ...info.next }] : []),
      ]
  const hasBump = tracks.some(t => t.majorBump)

  const footer = <Button onClick={p.onClose}>{t('common.close')}</Button>

  return (
    <Modal title={t('dsh.update.title', { name: p.dsh?.name ?? '' })} open={p.dsh !== null}
      onCancel={p.onClose} closable mask={{ closable: true }}
      width={MODAL.narrow} footer={footer} destroyOnHidden>
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        {checking && <div><Spin size="small" /> {t('dsh.update.checking')}</div>}

        {!checking && error !== '' && <Alert type="error" showIcon title={error} />}
        {!checking && error === '' && info === null && checking === false && (
          <Alert type="success" showIcon title={t('dsh.update.upToDate')} />
        )}

        {!checking && error === '' && info !== null && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: token.colorTextSecondary }}>{t('dsh.update.current')}</span>
              <code>{info.current || t('common.unknown')}</code>
            </div>
            {info.latest === undefined && info.next !== undefined && (
              <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
                {t('dsh.update.latestCurrent')}
              </div>
            )}
            <Space orientation="vertical" style={{ width: '100%' }}>
              {tracks.map(trk => (
                <div
                  key={trk.key}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                    border: `1px solid ${token.colorBorder}`, borderRadius: token.borderRadiusLG, padding: '10px 12px',
                  }}
                >
                  <Space size={6}>
                    <Tag color={trk.key === 'latest' ? 'blue' : 'purple'}>
                      {trk.key === 'latest' ? t('dsh.update.track.latest') : t('dsh.update.track.next')}
                    </Tag>
                    <code>{trk.version}</code>
                    {trk.majorBump && <Tag color="orange">{t('dsh.update.bump')}</Tag>}
                  </Space>
                  <Button
                    size="small" type="primary"
                    disabled={trk.majorBump && !ackMajor}
                    onClick={() => void doUpdate(trk.version)}
                  >
                    {t('dsh.update.go')}
                  </Button>
                </div>
              ))}
            </Space>
            {hasBump && (
              <>
                <Alert type="warning" showIcon title={t('dsh.update.majorWarn')} />
                <Checkbox checked={ackMajor} onChange={e => setAckMajor(e.target.checked)}>
                  {t('dsh.update.ackMajor')}
                </Checkbox>
              </>
            )}
          </>
        )}

        </Space>
    </Modal>
  )
}

