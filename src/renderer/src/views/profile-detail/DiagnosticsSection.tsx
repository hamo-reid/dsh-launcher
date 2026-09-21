/**
 * The composition report: whether the profile can boot, what is malformed, and the
 * findings the inspector counts.
 *
 * Purely presentational — the workspace owns the report and the collapse flag,
 * because the inspector's issue rows jump into this section and expand the conflict
 * list on the way.
 */
import { Alert, Button, Space, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { layerLabel } from '../../lib/profileLayers.ts'
import type { ProfileValidation } from '../../../../shared/types.ts'

interface Props {
  /** The last report, or `null` before one has run. */
  validation: ProfileValidation | null
  /** A check is in flight. */
  validating: boolean
  conflictsOpen: boolean
  onToggleConflicts: () => void
}

export default function DiagnosticsSection({ validation, validating, conflictsOpen, onToggleConflicts }: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM }

  if (validation === null) {
    return <div style={{ color: token.colorTextTertiary }}>{validating ? t('common.loading') : t('profile.workspace.noReport')}</div>
  }

  return (
    <div>
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <Alert type={validation.ok ? 'success' : 'error'} showIcon title={validation.ok ? t('profile.workspace.ok') : t('profile.workspace.problems')} />
        {validation.manifestError !== undefined && <Alert type="error" showIcon title={t('profile.workspace.manifestError')} description={validation.manifestError} />}
        {validation.patchError !== undefined && <Alert type="error" showIcon title={t('profile.workspace.patchError')} description={validation.patchError} />}
        {validation.conflicts.length > 0 && (
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {t('profile.detail.insertConflictTitle')}（{validation.conflicts.length}）
              <Button type="link" size="small" style={{ padding: 0, marginInlineStart: 8 }} onClick={onToggleConflicts}>
                {conflictsOpen ? t('common.collapse') : t('common.expand')}
              </Button>
            </div>
            {conflictsOpen && (
              <ul style={{ margin: 0, paddingInlineStart: 18, maxHeight: 240, overflowY: 'auto' }}>
                {validation.conflicts.map((c) => {
                  const names = c.layers.map((l) => { const label = layerLabel(l); return t(label.key, label.options) })
                  return <li key={c.id}><code>{c.id}</code> — {names.join(' + ')}</li>
                })}
              </ul>
            )}
          </div>
        )}
        {validation.missingBundles.length > 0 && (
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('profile.workspace.missingBundles')}</div>
            <div style={mono}>{validation.missingBundles.join(t('common.listSep'))}</div>
          </div>
        )}
        {validation.unclaimedBundles.length > 0 && (
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('profile.workspace.unclaimedBundles')}</div>
            <div style={mono}>{validation.unclaimedBundles.join(t('common.listSep'))}</div>
          </div>
        )}
      </Space>
    </div>
  )
}
