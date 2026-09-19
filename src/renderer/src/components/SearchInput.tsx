import type { CSSProperties } from 'react'
import { Input, theme } from 'antd'
import { LoadingOutlined, SearchOutlined } from '@ant-design/icons'

interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Show a trailing spinner while a search is in flight. */
  loading?: boolean
  onPressEnter?: () => void
  /** Grow to fill the surrounding toolbar row (default). */
  grow?: boolean
  ariaLabel?: string
  style?: CSSProperties
}

/**
 * Standard search field for the collection toolbars: a leading search icon, a
 * clear affordance, and an optional trailing loading spinner. Keeps the search
 * control (icon / clear / sizing) identical across plugins, download, market.
 */
export default function SearchInput({
  value, onChange, placeholder, loading = false, onPressEnter, grow = true, ariaLabel, style,
}: SearchInputProps): JSX.Element {
  const { token } = theme.useToken()
  return (
    <Input
      allowClear
      value={value}
      onChange={event => onChange(event.target.value)}
      onPressEnter={onPressEnter}
      placeholder={placeholder}
      aria-label={ariaLabel}
      prefix={<SearchOutlined style={{ color: token.colorTextTertiary }} />}
      suffix={loading ? <LoadingOutlined /> : undefined}
      style={{ ...(grow ? { flex: 1, minWidth: 200, maxWidth: 360 } : {}), ...style }}
    />
  )
}
