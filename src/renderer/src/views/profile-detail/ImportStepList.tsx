/**
 * The streamed step rows, shared by the import and mirror dialogs.
 *
 * The two flows differ only in how a bundle row is labelled, which is the caller's
 * business; the shape, the grouping headers and the error affordance are not.
 */
import { Button, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { StepIcon } from '../../components/StepIcon.tsx'
import type { StepRow } from '../../lib/stepRows.ts'

interface Props {
  rows: StepRow[]
  /** Show a failed row's detail. Omitted by a caller with no detail dialog. */
  onShowDetail?: (detail: string) => void
}

export default function ImportStepList({ rows, onShowDetail }: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  if (rows.length === 0) return <></>

  let prevSection: StepRow['section'] | undefined
  return (
    <div style={{ borderTop: `1px solid ${token.colorSplit}`, paddingTop: token.paddingSM }}>
      {rows.map((row) => {
        const isNewSection = row.section !== prevSection
        prevSection = row.section
        return (
          <div key={row.key}>
            {isNewSection && (
              <div style={{ margin: '6px 0 2px', color: token.colorTextSecondary, fontSize: token.fontSizeSM, fontWeight: 600 }}>
                {row.section === 'bundle' ? t('profile.import.sectionBundles') : t('profile.import.sectionInstall')}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
              <StepIcon status={row.status} />
              <span style={{ flex: 1, minWidth: 0 }}>{row.label}</span>
              {row.meta !== undefined && (
                <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>{row.meta}</span>
              )}
              {row.status === 'error' && onShowDetail !== undefined && (
                <Button type="link" size="small" style={{ padding: 0, color: token.colorError }} onClick={() => onShowDetail(row.detail ?? '')}>{t('profile.import.errorLabel')}</Button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
