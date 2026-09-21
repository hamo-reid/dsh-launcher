/**
 * The workspace's right rail: what this profile is made of, and every problem the
 * last check found.
 *
 * Each issue is a jump — the rail is how you get from "there is a conflict" to the
 * section that can fix it, which is why it navigates by section key rather than
 * only reporting.
 */
import { Alert, Badge, Button, Space, theme } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { ProfileValidation } from '../../../../shared/types.ts'
import type { SectionKey } from './sections.ts'

interface Props {
  /** The last report, or `null` before one has run. */
  validation: ProfileValidation | null
  validating: boolean
  bundleCount: number
  patchRowCount: number
  depCount: number
  onValidate: () => void
  onReveal: () => void
  /** Navigate to a section; `expandConflicts` also opens its conflict list. */
  onJump: (section: SectionKey, expandConflicts?: boolean) => void
}

export default function ProfileInspector({
  validation, validating, bundleCount, patchRowCount, depCount, onValidate, onReveal, onJump,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const issueRow = (label: string, count: number | undefined, onClick: () => void): JSX.Element => (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: token.colorPrimary }}
    >
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {count !== undefined && <Badge count={count} size="small" />}
    </div>
  )

  return (
    <div style={{ width: 280, flexShrink: 0, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: token.paddingSM }}>
      <div style={{ fontWeight: 600, color: token.colorText }}>{t('profile.workspace.inspector')}</div>
      {validation === null
        ? <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>{validating ? t('common.loading') : t('profile.workspace.noReport')}</div>
        : (
          <>
            <Alert type={validation.ok ? 'success' : 'error'} showIcon title={validation.ok ? t('profile.workspace.ok') : t('profile.workspace.problems')} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>
              <span>{t('profile.workspace.summaryBundles', { count: bundleCount })}</span>
              <span>{t('profile.workspace.summaryPatchRows', { count: patchRowCount })}</span>
              <span>{t('profile.workspace.summaryDeps', { count: depCount })}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: token.fontSizeSM }}>
              {validation.manifestError !== undefined && issueRow(t('profile.workspace.manifestError'), undefined, () => onJump('manifest'))}
              {validation.patchError !== undefined && issueRow(t('profile.workspace.patchError'), undefined, () => onJump('patch'))}
              {validation.conflicts.length > 0 && issueRow(t('profile.detail.insertConflictTitle'), validation.conflicts.length, () => onJump('diagnostics', true))}
              {validation.missingBundles.length > 0 && issueRow(t('profile.workspace.missingBundles'), validation.missingBundles.length, () => onJump('bundles'))}
              {validation.unclaimedBundles.length > 0 && issueRow(t('profile.workspace.unclaimedBundles'), validation.unclaimedBundles.length, () => onJump('bundles'))}
            </div>
            <Space size={8}>
              <Button size="small" onClick={onValidate} loading={validating}>{t('profile.workspace.validate')}</Button>
              <Button size="small" icon={<FolderOpenOutlined />} onClick={onReveal}>{t('profile.workspace.reveal')}</Button>
            </Space>
          </>
        )}
    </div>
  )
}
