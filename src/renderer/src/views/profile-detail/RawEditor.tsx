/**
 * The body of a raw-file section: optional controls, a hint line, a Monaco editor
 * filling the remaining height, and a save button.
 *
 * The manifest and home sections are this shape with different content, so they
 * share one component instead of two copies of the loading/Suspense dance. The
 * editor stays a `lazy()` import here — the Monaco wrapper must not reach the first
 * parse.
 */
import { lazy, Suspense, type ReactNode } from 'react'
import { Button, theme } from 'antd'
import { useTranslation } from 'react-i18next'

const CodeEditor = lazy(() => import('../../components/CodeEditor.tsx'))

interface Props {
  hint: string
  value: string
  onChange: (next: string) => void
  language: 'json' | 'yaml'
  /** The file is being read. */
  loading: boolean
  saving: boolean
  onSave: () => void
  /** Controls above the hint — the manifest's display-name / reload form. */
  header?: ReactNode
}

export default function RawEditor({ hint, value, onChange, language, loading, saving, onSave, header }: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const waiting = <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextTertiary }}>{t('common.loading')}</div>
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: token.paddingSM }}>
      {header}
      <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>{hint}</div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {loading ? waiting : <Suspense fallback={waiting}><CodeEditor value={value} language={language} onChange={onChange} height="100%" /></Suspense>}
      </div>
      <div>
        <Button type="primary" loading={saving} onClick={onSave}>{t('common.save')}</Button>
      </div>
    </div>
  )
}
