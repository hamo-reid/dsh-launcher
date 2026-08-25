import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined } from '@ant-design/icons'
import { theme } from 'antd'

/** Status of one progress row / install step. */
export type RowStatus = 'running' | 'ok' | 'error'

/** Colored step icon for a progress row (spinner / check / cross), token-driven
 * so the same three states render identically across every install/import modal. */
export function StepIcon({ status }: { status: RowStatus }): JSX.Element {
  const { token } = theme.useToken()
  if (status === 'running') return <LoadingOutlined spin style={{ color: token.colorWarning }} />
  if (status === 'ok') return <CheckCircleFilled style={{ color: token.colorSuccess }} />
  return <CloseCircleFilled style={{ color: token.colorError }} />
}