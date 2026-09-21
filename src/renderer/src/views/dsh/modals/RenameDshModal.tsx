/** Rename a registered dsh's display name (the install and home are untouched). */
import { useEffect, useState } from 'react'
import { Input, Modal, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../../../lib/ipc.ts'
import FieldLabel from '../../../components/FieldLabel.tsx'

// ── Rename ─────────────────────────────────────────────────────────────────

interface RenameDshModalProps {
  target: { id: string; name: string } | null
  onClose: () => void
  onDone: () => void | Promise<void>
}
export function RenameDshModal(p: RenameDshModalProps): JSX.Element {
  const { t } = useTranslation()
  const [renameName, setRenameName] = useState('')
  useEffect(() => { if (p.target !== null) setRenameName(p.target.name) }, [p.target])

  const doRename = async (): Promise<void> => {
    if (p.target === null) return
    const r = await window.api.dsh.rename(p.target.id, renameName.trim())
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    p.onClose()
    void message.success(t('dsh.rename.done'))
    await p.onDone()
  }

  return (
    <Modal title={`${t('dsh.rename.title')}${p.target !== null ? ` · ${p.target.name}` : ''}`} open={p.target !== null}
      okText={t('common.save')} onOk={() => void doRename()} onCancel={p.onClose} destroyOnHidden>
      <FieldLabel>{t('dsh.rename.newAlias')}</FieldLabel>
      <Input value={renameName} onChange={e => setRenameName(e.target.value)} placeholder={t('dsh.rename.newAlias')} onPressEnter={() => void doRename()} />
    </Modal>
  )
}

