import { useState, type ReactNode } from 'react'
import { Spin, theme } from 'antd'
import EmptyState from './EmptyState.tsx'

interface NavListProps<T> {
  items: readonly T[]
  keyOf: (item: T) => string
  selectedKey?: string
  onSelect?: (item: T) => void
  renderTitle: (item: T, selected: boolean) => ReactNode
  renderMeta?: (item: T) => ReactNode
  /** Right-aligned action trigger(s) (e.g. a ConfirmMenu). */
  actions?: (item: T) => ReactNode
  empty?: ReactNode
  loading?: boolean
}

/** One block-style row: canvas-tinted so it lifts off the white rail, with a
 * primary accent bar + tint when selected. Hover lifts it with a tint. */
function NavItem({ title, meta, onSelect, actions, selected }: {
  title: ReactNode
  meta?: ReactNode
  onSelect?: () => void
  actions?: ReactNode
  selected?: boolean
}) {
  const { token } = theme.useToken()
  const [hovered, setHovered] = useState(false)
  const clickable = onSelect !== undefined
  const active = selected ?? false
  const borderColor = active ? token.colorPrimary : token.colorBorder
  return (
    <div
      role="option"
      aria-selected={active}
      onClick={clickable ? onSelect : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={clickable ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.() }
      } : undefined}
      tabIndex={clickable ? 0 : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        cursor: clickable ? 'pointer' : 'default',
        padding: '10px 12px',
        borderRadius: token.borderRadiusLG,
        background: active ? token.colorPrimaryBg : (hovered ? token.colorPrimaryBgHover : token.colorBgLayout),
        border: `1px solid ${borderColor}`,
        borderInlineStart: active ? `3px solid ${token.colorPrimary}` : `1px solid ${borderColor}`,
        marginBottom: 8,
        transition: 'background 0.15s',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontWeight: active ? 600 : 400, color: token.colorText,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {title}
        </div>
        {meta !== undefined && (
          <div style={{ fontSize: token.fontSizeSM, color: token.colorTextTertiary, marginTop: 2 }}>{meta}</div>
        )}
      </div>
      {actions !== undefined && (
        <div style={{ flex: '0 0 auto' }} onClick={event => event.stopPropagation()}>{actions}</div>
      )}
    </div>
  )
}

/**
 * Clickable navigation list with unified block-style rows (canvas-tinted with
 * activate accent on select, tint on hover). Shared by DshSection and
 * ProfileSection so the two rails stay visually identical.
 */
export default function NavList<T>({
  items, keyOf, selectedKey, onSelect, renderTitle, renderMeta, actions, empty, loading,
}: NavListProps<T>): ReactNode {
  if (loading) return <Spin style={{ display: 'block', margin: '24px auto' }} />
  if (items.length === 0) return empty ?? <EmptyState />
  return (
    <div role="listbox" style={{ padding: '0 8px' }}>
      {items.map(item => {
        const key = keyOf(item)
        const selected = key === selectedKey
        return (
          <NavItem
            key={key}
            title={renderTitle(item, selected)}
            meta={renderMeta !== undefined ? renderMeta(item) : undefined}
            actions={actions !== undefined ? actions(item) : undefined}
            selected={selected}
            onSelect={onSelect !== undefined ? () => onSelect(item) : undefined}
          />
        )
      })}
    </div>
  )
}