import type { ReactNode } from 'react'
import { Empty, theme } from 'antd'
import { useTranslation } from 'react-i18next'

interface EmptyStateProps {
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
}

/** Consistent call-to-action empty state across sections. */
export default function EmptyState({ title, description, action }: EmptyStateProps) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const head = title ?? t('common.noData')
  return (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: token.paddingLG * 2 }}>
      <div style={{ fontSize: token.fontSizeLG, fontWeight: 500, color: token.colorTextSecondary, marginBottom: 6 }}>
        {head}
      </div>
      {description !== undefined && (
        <div style={{ color: token.colorTextTertiary, marginBottom: action !== undefined ? token.padding : 0 }}>
          {description}
        </div>
      )}
      {action !== undefined && <div style={{ marginTop: token.paddingLG }}>{action}</div>}
    </Empty>
  )
}