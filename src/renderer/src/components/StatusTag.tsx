import type { ReactNode } from 'react'
import { Tag } from 'antd'

/** Semantic status tones with a fixed Tag color mapping. */
export type StatusTone = 'enabled' | 'disabled' | 'network' | 'bundle'

const TONE_COLOR: Record<StatusTone, string> = {
  enabled: 'green',
  disabled: 'red',
  network: 'blue',
  bundle: 'default',
}

interface StatusTagProps {
  tone: StatusTone
  children: ReactNode
}

/** Consistent status chip (Tag) with a fixed tone → color map. */
export default function StatusTag({ tone, children }: StatusTagProps) {
  return (
    <Tag color={TONE_COLOR[tone]} style={{ marginInlineEnd: 0 }}>
      {children}
    </Tag>
  )
}