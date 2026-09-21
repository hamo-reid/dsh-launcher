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
  cancelText?: string
  onOk?: () => void | Promise<void>
  okDisabled?: boolean
  confirmLoading?: boolean
  destroyOnHidden?: boolean
  /** Scroll-body max height: 'md' (420px) | 'lg' (60vh) | explicit px number. */
  bodyMax?: BodyHeight
  /** Whether a click on the mask closes the dialog. Off by default, because the
   * dialogs this was built for (dnd-kit bundle reorder, long spec lists) must not
   * vanish under a stray click — pass `true` for a dialog that used to be a plain
   * `Modal`, which is closable that way. */
  maskClosable?: boolean
}

/**
 * Modal with a scrollable body, so long lists/specs never overflow the dialog.
 * Encapsulates the repeated `maxHeight + overflowY:auto` wrapper spread across views.
 */
export default function ScrollModal({
  title, open, onCancel, children, width, footer, okText, cancelText, onOk,
  okDisabled, confirmLoading, destroyOnHidden, bodyMax = 'md', maskClosable = false,
}: ScrollModalProps) {
  const height = typeof bodyMax === 'number' ? `${bodyMax}px` : BODY_HS[bodyMax]
  return (
    <Modal
      title={title}
      open={open}
      onCancel={onCancel}
      // Long interactive lists (e.g. dnd-kit bundle reorder) must not close under a
      // stray mask click; a dialog that used to be a plain `Modal` opts back in.
      mask={{ closable: maskClosable }}
      width={width}
      footer={footer}
      okText={okText}
      cancelText={cancelText}
      onOk={onOk}
      okButtonProps={okDisabled !== undefined ? { disabled: okDisabled } : undefined}
      confirmLoading={confirmLoading}
      destroyOnHidden={destroyOnHidden}
    >
      <div style={{ maxHeight: height, overflowY: 'auto', overflowX: 'hidden' }}>{children}</div>
    </Modal>
  )
}