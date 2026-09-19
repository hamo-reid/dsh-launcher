import type { ReactNode } from 'react'
import { Button, Tag } from 'antd'

export interface FilterChip {
  key: string
  label: ReactNode
  onClose: () => void
}

/** Removable active-filter chips with an optional "clear all", rendered inside a
 * {@link Toolbar} chip strip so every collection view shows its filter state. */
export default function FilterChips({ items, onClear, clearLabel }: {
  items: FilterChip[]
  onClear?: () => void
  clearLabel?: string
}): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <>
      {items.map(chip => <Tag key={chip.key} closable onClose={chip.onClose}>{chip.label}</Tag>)}
      {onClear !== undefined && <Button type="link" size="small" onClick={onClear}>{clearLabel}</Button>}
    </>
  )
}
