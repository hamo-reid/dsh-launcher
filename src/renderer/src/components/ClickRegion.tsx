import type { CSSProperties, ReactNode } from 'react'

interface ClickRegionProps {
  /** What activating the region does — by click, or by Enter / Space, as a
   * button is activated. */
  onOpen: () => void
  /** The accessible name: what this region opens, not what it contains. */
  label: string
  style?: CSSProperties
  /** Extra classes; `pm-click-region` gives the hover tint (see global.css). */
  className?: string
  children: ReactNode
}

/**
 * The clickable part of a card or list row whose frame belongs to its caller.
 *
 * It exists for the CONTRACT, which is why it is shared rather than copied: a
 * region that opens something must be reachable with the mouse AND the keyboard
 * (Enter/Space), and it must hold no interactive element of its own — a card's
 * buttons are SIBLINGS of this region, never descendants, or one click would
 * activate both. `PluginCard` documents the same rule where it was first needed.
 *
 * `ActionCard` covers the other case: a whole card that is the target, with a
 * trailing node for controls. This is for a surface that owns its own frame and
 * its own action row.
 *
 * The focus outline is deliberately left alone: antd's own controls draw one, and
 * a region with none would leave keyboard users unable to see where they are.
 */
export default function ClickRegion({
  onOpen, label, style, className, children,
}: ClickRegionProps): JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      className={className}
      onClick={onOpen}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() }
      }}
      style={{ cursor: 'pointer', ...style }}
    >
      {children}
    </div>
  )
}
