/**
 * Remove a dsh from the registry, optionally deleting its files — which is a second
 * confirmation, because a managed install takes its home with it.
 */
import { useState } from 'react'
import { Button, Modal, Space, message, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../../lib/ipc.ts'
import { MODAL } from '../../../theme.ts'

// ── Remove (optionally deleting files, with a second confirm) ───────────────

interface DshRemoveModalProps {
  dsh: { id: string; name: string } | null
  onClose: () => void
  /** Called once removed, so the owner refreshes the list. */
  onRemoved: () => void | Promise<void>
}
export function DshRemoveModal(p: DshRemoveModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [busy, setBusy] = useState(false)

  const removeNow = async (): Promise<void> => {
    if (p.dsh === null) return
    setBusy(true)
    try {
      // 移除即删除安装文件（含官方安装的独立 home）。仅从列表脱管会让版本库自动发现
      // 把它重新收录回来，故不再提供「仅移除」；不可逆保护交给 doRemove 的强确认。
      const r = await window.api.dsh.remove(p.dsh.id, { deleteFiles: true })
      if (!r.ok) { void message.error(apiErrorText(r)); return }
      void message.success(t('dsh.removed'))
      p.onClose()
      await p.onRemoved()
    } finally {
      setBusy(false)
    }
  }

  const doRemove = (): void => {
    // 两步确认：先在弹窗点「移除」，再经强确认后才真正删除文件。
    Modal.confirm({
      title: t('dsh.remove.confirmDeleteTitle'),
      content: t('dsh.remove.confirmDelete', { name: p.dsh?.name ?? '' }),
      okText: t('common.confirm'),
      okButtonProps: { danger: true },
      onOk: () => void removeNow(),
    })
  }

  return (
    <Modal title={t('dsh.remove.title')} open={p.dsh !== null} onCancel={busy ? undefined : p.onClose}
      closable={!busy} mask={{ closable: !busy }} width={MODAL.narrow}
      footer={(
        <Space>
          <Button onClick={p.onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button type="primary" danger loading={busy} onClick={() => void doRemove()}>{t('dsh.remove.remove')}</Button>
        </Space>
      )}>
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
          {t('dsh.remove.hint')}
        </div>
      </Space>
    </Modal>
  )
}
