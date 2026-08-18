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

/** Kebab (…) action menu with optional per-item confirm — the unified
 * row-action trigger used across lists. */
export default function ConfirmMenu({ actions, onAction }: ConfirmMenuProps) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const run = (action: MenuAction): void => {
    if (action.confirmText !== undefined) {
      Modal.confirm({
        title: action.label,
        content: action.confirmText,
        okText: t('common.confirm'),
        okButtonProps: { danger: action.danger === true },
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