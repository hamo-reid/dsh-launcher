import type { CSSProperties, ReactNode } from 'react'
import { theme } from 'antd'

interface ToolbarProps {
  /** The control row (search / filters / sort). Wraps when narrow. */
  children: ReactNode
  /** Optional active-filter chips strip, rendered under the control row. */
  chips?: ReactNode
  style?: CSSProperties
}

/**
 * Standard flush-Panel header used by the collection views (plugins, download
 * center, market): a wrapping control row plus an optional active-filter chips
 * strip. Keeps the search + filter + sort bar visually identical everywhere.
 */
export default function Toolbar({ children, chips, style }: ToolbarProps): JSX.Element {
  const { token } = theme.useToken()
  return (
    <div style={{ borderBottom: `1px solid ${token.colorSplit}`, ...style }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: token.paddingSM, flexWrap: 'wrap',
        padding: `${token.paddingSM}px ${token.padding}px`,
      }}>
        {children}
      </div>
      {chips !== undefined && (
        <div style={{
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6,
          padding: `6px ${token.padding}px`, background: token.colorFillQuaternary, borderTop: `1px solid ${token.colorSplit}`,
        }}>
          {chips}
        </div>
      )}
    </div>
  )
}
