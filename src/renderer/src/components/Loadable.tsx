import type { ReactNode } from 'react'
import { Skeleton } from 'antd'

interface LoadableProps {
  loading: boolean
  children?: ReactNode
  /** Skeleton paragraph rows while loading. */
  rows?: number
}

/** Skeleton while `loading`, otherwise children — the standard loading state. */
export default function Loadable({ loading, children, rows = 3 }: LoadableProps) {
  if (!loading) return <>{children}</>
  return <Skeleton active title={false} paragraph={{ rows }} />
}