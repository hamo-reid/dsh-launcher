import type { CSSProperties, ReactNode } from 'react'
import { theme } from 'antd'

interface SectionHeadingProps {
  title: ReactNode
  description?: ReactNode
  /** Right-aligned action area (buttons, selects, …). */
  extra?: ReactNode
  /** When true, stick the header to the top of the scrolling content (used for
   * fixed toolbars like Profile's launch/stop row) and give it a solid base. */
  sticky?: boolean
}

/** Standard page/section header. As a Main Header it carries a subtle bottom
 * divider so it reads as a distinct header band over the canvas — not flat text
 * that blends into the background. `sticky` promotes it to a fixed toolbar. */
export default function SectionHeading({ title, description, extra, sticky = false }: SectionHeadingProps) {
  const { token } = theme.useToken()
  const headStyle: CSSProperties = sticky
    ? { position: 'sticky', top: 0, zIndex: 10, background: token.colorBgContainer, boxShadow: `0 1px 0 ${token.colorBorder}` }
    : { borderBottom: `1px solid ${token.colorSplit}`, paddingBottom: token.paddingSM }
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: token.padding,
        marginBottom: token.paddingSM,
        padding: sticky ? `${token.paddingSM}px ${token.padding}px` : 0,
        minWidth: 0,
        ...headStyle,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: token.fontSizeLG, fontWeight: 600, color: token.colorText, lineHeight: token.lineHeightLG }}>
          {title}
        </div>
        {description !== undefined && (
          <div style={{ color: token.colorTextSecondary, marginTop: 2 }}>{description}</div>
        )}
      </div>
      {extra !== undefined && <div style={{ flex: '0 0 auto' }}>{extra}</div>}
    </div>
  )
}