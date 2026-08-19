import type { ReactNode } from 'react'
import { Modal } from 'antd'

type BodyHeight = 'md' | 'lg' | number
const BODY_HS: Record<'md' | 'lg', string> = { md: '420px', lg: '60vh' }

interface ScrollModalProps {
  title: ReactNode
  open: boolean
  onCancel: () => void
  children: ReactNode
  /** Modal width — pass MODAL.wide / MODAL.narrow (or keep unset for antd default). */
  width?: string | number
  footer?: ReactNode
  okText?: string
  onOk?: () => void | Promise<void>
  okDisabled?: boolean
  confirmLoading?: boolean
  destroyOnClose?: boolean
  /** Scroll-body max height: 'md' (420px) | 'lg' (60vh) | explicit px number. */
  bodyMax?: BodyHeight
}

/**
 * Modal with a scrollable body, so long lists/specs never overflow the dialog.
 * Encapsulates the repeated `maxHeight + overflowY:auto` wrapper spread across views.
 */
export default function ScrollModal({
  title, open, onCancel, children, width, footer, okText, onOk,
  okDisabled, confirmLoading, destroyOnClose, bodyMax = 'md',
}: ScrollModalProps) {
  const height = typeof bodyMax === 'number' ? `${bodyMax}px` : BODY_HS[bodyMax]
  return (
    <Modal
      title={title}
      open={open}
      onCancel={onCancel}
      // These scroll-body dialogs hold long interactive lists (e.g. dnd-kit bundle
      // reorder); a click on the mask that escapes the content must not close one.
      maskClosable={false}
      width={width}
      footer={footer}
      okText={okText}
      onOk={onOk}
      okButtonProps={okDisabled !== undefined ? { disabled: okDisabled } : undefined}
      confirmLoading={confirmLoading}
      destroyOnClose={destroyOnClose}
    >
      <div style={{ maxHeight: height, overflowY: 'auto', overflowX: 'hidden' }}>{children}</div>
    </Modal>
  )
}