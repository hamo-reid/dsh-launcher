import type { ReactNode } from 'react'
import { theme } from 'antd'

interface PanelProps {
  /** Optional section title in a header row. */
  title?: ReactNode
  description?: ReactNode
  /** Right-aligned header slot. */
  extra?: ReactNode
  children: ReactNode
  /** Body padding; set false for flush content (e.g. a full-bleed Table). */
  pad?: boolean
  /** Fill the available height as a flex column (body flexes), for panels whose
   * child owns its own scroll — e.g. a code editor. */
  fill?: boolean
}

/**
 * A white surface panel that lifts a functional block off the canvas
 * (`colorBgLayout`). Group flat content (descriptions, tables, forms, lists)
 * into panels so a view reads as a stack of distinguishable blocks rather than
 * one flat plane.
 */
export default function Panel({ title, description, extra, children, pad = true, fill = false }: PanelProps) {
  const { token } = theme.useToken()
  const header = title !== undefined || extra !== undefined
  return (
    <div
      style={{
        background: token.colorBgContainer,
        borderRadius: token.borderRadiusLG,
        border: `1px solid ${token.colorBorder}`,
        overflow: 'hidden',
        display: fill ? 'flex' : undefined,
        flexDirection: fill ? 'column' : undefined,
        flex: fill ? 1 : undefined,
        minHeight: fill ? 0 : undefined,
      }}
    >
      {header && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: token.padding,
            padding: `${token.paddingSM}px ${token.padding}px`,
            borderBottom: `1px solid ${token.colorSplit}`,
          }}
        >
          <div style={{ minWidth: 0 }}>
            {title !== undefined && (
              <div style={{ fontWeight: 600, color: token.colorText, lineHeight: token.lineHeightLG }}>{title}</div>
            )}
            {description !== undefined && (
              <div style={{ fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>{description}</div>
            )}
          </div>
          {extra !== undefined && <div style={{ flex: '0 0 auto' }}>{extra}</div>}
        </div>
      )}
      <div style={{
        padding: pad ? `${token.paddingSM}px ${token.padding}px ${token.padding}px` : 0,
        display: fill ? 'flex' : undefined,
        flexDirection: fill ? 'column' : undefined,
        flex: fill ? 1 : undefined,
        minHeight: fill ? 0 : undefined,
      }}>
        {children}
      </div>
    </div>
  )
}