import { Button, Modal, Space, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { MODAL } from '../theme.ts'

/** Modal showing the full error text behind a failed progress row. Used by every
 * install/import dialog so the copy / close footer is defined once. */
export function ErrorDetailModal(
  { open, detail, onClose, title }:
  { open: boolean; detail: string | null; onClose: () => void; title: string },
): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  return (
    <Modal title={title} open={open} onOk={onClose} onCancel={onClose} okText={t('common.close')} width={MODAL.wide}
      footer={(
        <Space>
          <Button onClick={() => { if (detail !== null) void navigator.clipboard.writeText(detail) }}>{t('common.copy')}</Button>
          <Button type="primary" onClick={onClose}>{t('common.close')}</Button>
        </Space>
      )}>
      <pre style={{ margin: 0, maxHeight: 400, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: token.colorFillTertiary, padding: token.paddingSM, borderRadius: token.borderRadius }}>
        {detail}
      </pre>
    </Modal>
  )
}