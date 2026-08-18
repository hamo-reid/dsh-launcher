import { useState, type ReactNode } from 'react'
import { theme } from 'antd'

interface ActionCardProps {
  /** Primary title (kept on one line, ellipsized). */
  title: ReactNode
  /** Small secondary line under the title. */
  meta?: ReactNode
  /** Right-aligned slot (status tag, action menu, …). */
  extra?: ReactNode
  /** Click handler; enables keyboard access when provided. */
  onClick?: () => void
  /** Selected state: primary-tinted background + left accent bar. */
  selected?: boolean
  /** Lift on hover (background tint). */
  hoverable?: boolean
  /** Disabled: dimmed and non-interactive. */
  disabled?: boolean
}

/**
 * A block-style clickable/selectable card used wherever a list of discrete
 * rows or entries needs to read as separable units (as opposed to faint
 * divider lines). All colours derive from theme tokens.
 */
export default function ActionCard({
  title, meta, extra, onClick, selected = false, hoverable = false, disabled = false,
}: ActionCardProps) {
  const { token } = theme.useToken()
  const [hovered, setHovered] = useState(false)
  const clickable = onClick !== undefined && !disabled
  const lifted = hoverable && hovered && !selected
  const background = selected ? token.colorPrimaryBg : (lifted ? token.colorPrimaryBgHover : token.colorBgContainer)
  const borderColor = selected ? token.colorPrimary : token.colorBorder

  return (
    <div
      onClick={clickable ? onClick : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={clickable ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick?.() }
      } : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: token.padding,
        padding: '10px 12px',
        borderRadius: token.borderRadiusLG,
        background,
        border: `1px solid ${borderColor}`,
        borderInlineStart: selected ? `3px solid ${token.colorPrimary}` : `1px solid ${borderColor}`,
        cursor: clickable ? 'pointer' : 'default',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.15s',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          color: token.colorText, fontWeight: 500, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {title}
        </div>
        {meta !== undefined && (
          <div style={{ fontSize: token.fontSizeSM, color: token.colorTextTertiary, marginTop: 2 }}>{meta}</div>
        )}
      </div>
      {extra !== undefined && <div style={{ flex: '0 0 auto' }}>{extra}</div>}
    </div>
  )
}