/**
 * The composition report: whether this profile can boot, what is malformed, and —
 * the part that makes it actionable — a jump to the section that can fix each
 * finding.
 *
 * The summary used to be a separate right rail (the inspector). Two panels that
 * both claim "these are the problems" is one panel too many: the rail sat next to
 * the report and repeated it, while the report sat one click away from the counts
 * that make a finding add up to a whole. They now live in one place, and every row
 * here navigates the way the rail's rows did.
 *
 * Purely presentational — the workspace owns the report and the collapse flag,
 * because a jump from here also expands the conflict list on the way.
 */
import { Alert, Badge, Button, Space, theme } from 'antd'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { layerLabel } from '../../lib/profileLayers.ts'
import type { ProfileValidation } from '../../../../shared/types.ts'
import type { SectionKey } from './sections.ts'

interface Props {
  /** The last report, or `null` before one has run. */
  validation: ProfileValidation | null
  /** A check is in flight. */
  validating: boolean
  bundleCount: number
  patchRowCount: number
  depCount: number
  conflictsOpen: boolean
  onToggleConflicts: () => void
  onValidate: () => void
  /** Navigate to a section; `expandConflicts` also opens its conflict list. */
  onJump: (section: SectionKey, expandConflicts?: boolean) => void
}

export default function DiagnosticsSection({
  validation, validating, bundleCount, patchRowCount, depCount,
  conflictsOpen, onToggleConflicts, onValidate, onJump,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM }

  // A finding that says only WHAT is wrong leaves the fixing to guesswork, so each
  // row is a link to the section that owns the file or the layer behind it.
  const jumpRow = (key: ReactNode, count: number | undefined, section: SectionKey, expandConflicts?: boolean): JSX.Element => (
    <button
      type="button"
      onClick={() => onJump(section, expandConflicts)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 0,
        border: 0, background: 'none', cursor: 'pointer', textAlign: 'start',
        color: token.colorPrimary, fontSize: token.fontSizeSM,
      }}
    >
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{key}</span>
      {count !== undefined && <Badge count={count} size="small" />}
    </button>
  )

  if (validation === null) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: token.paddingSM, alignItems: 'flex-start' }}>
        <div style={{ color: token.colorTextTertiary }}>{validating ? t('common.loading') : t('profile.workspace.noReport')}</div>
        {validating ? null : <Button size="small" onClick={onValidate}>{t('profile.workspace.validate')}</Button>}
      </div>
    )
  }

  // `validation.ok` is the boot verdict; the counts below are what it was decided
  // from. Keeping them adjacent is the point — "组合检查通过" next to "bundle 层：0"
  // is an honest answer, "通过" alone would not be.
  const summary = (
    <div style={{ display: 'flex', gap: token.padding, flexWrap: 'wrap', fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>
      <span>{t('profile.workspace.summaryBundles', { count: bundleCount })}</span>
      <span>{t('profile.workspace.summaryPatchRows', { count: patchRowCount })}</span>
      <span>{t('profile.workspace.summaryDeps', { count: depCount })}</span>
    </div>
  )

  return (
    <Space orientation="vertical" size="small" style={{ width: '100%' }}>
      <Alert
        type={validation.ok ? 'success' : 'error'}
        showIcon
        title={validation.ok ? t('profile.workspace.ok') : t('profile.workspace.problems')}
        description={summary}
        action={(
          <Button size="small" onClick={onValidate} loading={validating}>{t('profile.workspace.validate')}</Button>
        )}
      />
      {validation.manifestError !== undefined && (
        <Alert
          type="error"
          showIcon
          title={t('profile.workspace.manifestError')}
          description={<div style={mono}>{validation.manifestError}</div>}
          action={jumpRow(t('profile.workspace.fixManifest'), undefined, 'manifest')}
        />
      )}
      {validation.patchError !== undefined && (
        <Alert
          type="error"
          showIcon
          title={t('profile.workspace.patchError')}
          description={(
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {(validation.patchErrors ?? [validation.patchError]).map(line => <li key={line} style={mono}>{line}</li>)}
            </ul>
          )}
          action={jumpRow(t('profile.workspace.fixPatch'), undefined, 'patch')}
        />
      )}
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
          {jumpRow(t('profile.workspace.missingBundles'), validation.missingBundles.length, 'bundles')}
          <div style={mono}>{validation.missingBundles.join(t('common.listSep'))}</div>
        </div>
      )}
      {validation.unclaimedBundles.length > 0 && (
        <div>
          {jumpRow(t('profile.workspace.unclaimedBundles'), validation.unclaimedBundles.length, 'bundles')}
          <div style={mono}>{validation.unclaimedBundles.join(t('common.listSep'))}</div>
        </div>
      )}
    </Space>
  )
}
