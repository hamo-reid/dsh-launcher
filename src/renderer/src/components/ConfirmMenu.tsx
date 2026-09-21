import { Button, Dropdown, Modal, theme } from 'antd'
import { MoreOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

export interface MenuAction {
  key: string
  label: string
  danger?: boolean
  /** When set, clicking shows a confirm dialog before firing onAction. */
  confirmText?: string
}

interface ConfirmMenuProps {
  actions: MenuAction[]
  onAction: (key: string) => void
}

/**
 * The one confirm dialog behind every destructive row action — the kebab's
 * `confirmText` path and the explicit danger buttons share it, so the wording,
 * the danger styling, and the ok button can never drift between the two
 * triggers. (docs/ui-guidelines.md §3.6: a destructive action is never bare.)
 */
export function confirmDanger(opts: {
  title: string
  content?: string
  okText: string
  /** Most callers destroy something; pass `false` for a merely consequential
   * action (e.g. taking a dev-plugin snapshot) to keep the ok button neutral. */
  danger?: boolean
  onOk: () => void
}): void {
  Modal.confirm({
    title: opts.title,
    content: opts.content,
    okText: opts.okText,
    okButtonProps: { danger: opts.danger !== false },
    onOk: opts.onOk,
  })
}

/** Kebab (…) action menu with optional per-item confirm — the unified
 * row-action trigger used across lists. */
export default function ConfirmMenu({ actions, onAction }: ConfirmMenuProps) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const run = (action: MenuAction): void => {
    if (action.confirmText !== undefined) {
      confirmDanger({
        title: action.label,
        content: action.confirmText,
        okText: t('common.confirm'),
        danger: action.danger === true,
        onOk: () => onAction(action.key),
      })
    } else {
      onAction(action.key)
    }
  }
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: actions.map(action => ({ key: action.key, label: action.label, danger: action.danger === true })),
        onClick: ({ key }) => {
          const action = actions.find(candidate => candidate.key === key)
          if (action !== undefined) run(action)
        },
      }}
    >
      <Button
        type="text"
        size="small"
        shape="circle"
        icon={<MoreOutlined />}
        onClick={event => event.stopPropagation()}
        style={{ color: token.colorTextTertiary }}
        aria-label={t('common.moreActions')}
      />
    </Dropdown>
  )
}