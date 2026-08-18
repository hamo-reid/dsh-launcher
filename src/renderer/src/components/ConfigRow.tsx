import { useState } from 'react'
import { Button, Input, Modal, theme, message } from 'antd'
import { useTranslation } from 'react-i18next'
import SectionHeading from './SectionHeading.tsx'
import { MODAL } from '../theme.ts'

interface Props {
  title: string
  description?: string
  /** The current value; empty shows "unconfigured". */
  value: string
  /** Apply a new value; resolves to an error string, or '' on success. */
  onSave: (next: string) => Promise<string>
}

/** A single-config edit flow: shows the current value (+「Edit」), opens a small
 * dialog (title "Edit X", input, confirm/cancel) to edit it. */
export default function ConfigRow({ title, description, value, onSave }: Props) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const openEdit = (): void => {
    setDraft(value)
    setOpen(true)
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    const error = await onSave(draft.trim())
    setBusy(false)
    if (error !== '') { void message.error(error); return }
    void message.success(t('common.updatedWithTitle', { title }))
    setOpen(false)
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <SectionHeading title={title} description={description} />
      <div style={{ display: 'flex', alignItems: 'center', gap: token.paddingSM }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: value.trim() === '' ? token.colorTextTertiary : token.colorText,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {value.trim() === '' ? t('common.unconfigured') : value}
        </span>
        <Button onClick={openEdit}>{t('common.edit')}</Button>
      </div>

      <Modal
        title={t('common.editModalTitle', { title })}
        open={open}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onOk={() => void save()}
        onCancel={() => setOpen(false)}
        confirmLoading={busy}
        width={MODAL.narrow}
      >
        <Input value={draft} onChange={e => setDraft(e.target.value)} onPressEnter={() => void save()} />
      </Modal>
    </div>
  )
}