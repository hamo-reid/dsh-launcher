import { theme } from 'antd'
import { useTranslation } from 'react-i18next'
import type { DataRootState } from '../../../shared/types.ts'

/** The three directories the data root derives, read-only.
 *
 * Shown wherever the root is edited, so the user can see what a choice actually
 * creates. The labels are the names the settings page has always used, so
 * anyone who set one of them individually recognises where it went. */
export default function DerivedDirs({ derived }: { derived: DataRootState['derived'] }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const rows = [
    { label: t('settings.pluginDir'), path: derived.plugins },
    { label: t('settings.skillLibrary'), path: derived.skillLibrary },
    { label: t('settings.dshVersionDir'), path: derived.dshVersions },
  ]
  return (
    <div style={{ marginBottom: token.paddingLG }}>
      {rows.map(row => (
        <div key={row.label} style={{ display: 'flex', gap: token.paddingSM, marginTop: 6 }}>
          <span style={{ width: 96, flexShrink: 0, color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
            {row.label}
          </span>
          <span
            title={row.path}
            style={{
              flex: 1, minWidth: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: token.fontSizeSM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {row.path}
          </span>
        </div>
      ))}
    </div>
  )
}
