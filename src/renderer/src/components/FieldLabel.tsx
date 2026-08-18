import type { ReactNode } from 'react'
import { Typography, theme } from 'antd'

interface FieldLabelProps {
  children: ReactNode
  required?: boolean
}

/** Form field label with an optional required marker — pairs form controls
 * with stable, accessible labels. */
export default function FieldLabel({ children, required }: FieldLabelProps) {
  const { token } = theme.useToken()
  return (
    <Typography.Text style={{ display: 'block', marginBottom: 6, color: token.colorTextSecondary }}>
      {required && <span style={{ color: token.colorError, marginRight: 4 }}>*</span>}
      {children}
    </Typography.Text>
  )
}