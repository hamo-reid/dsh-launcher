/**
 * A dev package's diagnosis: the patch rows dsh actually loads, then the peers a
 * `link:` must resolve from the dev package itself, then the fixes for whatever
 * is wrong (install / shim / build).
 *
 * A monorepo plugin can carry dozens of rows and peers, so the body scrolls INSIDE
 * the dialog — otherwise the list grows past the viewport and the action row at
 * the bottom becomes unreachable.
 *
 * The compare target lives here rather than in the page header: the report below
 * only means anything together with the chain it was computed for, and changing
 * the selector here is what invalidates it.
 */
import { Alert, Button, Dropdown, Select, Space, Tag, Tooltip, theme } from 'antd'
import type { MenuProps } from 'antd'
import { useTranslation } from 'react-i18next'
import { hostLabel, parseBuildKey, resolveDescriptor, scopeLabel, type DevTarget } from '../../../lib/devPlugins.ts'
import FieldLabel from '../../../components/FieldLabel.tsx'
import ScrollModal from '../../../components/ScrollModal.tsx'
import { MODAL } from '../../../theme.ts'
import type { HostOption, OpenReport } from '../useDevPlugins.ts'
import type { DevBuildTarget, DevResolveRoot, DevResolveState } from '../../../../../shared/types.ts'

interface Props {
  /** The report to show; the dialog is open while this is set. */
  report: OpenReport | null
  /** The action currently running, as `${kind}:${name}` — empty when idle. */
  busy: string
  hosts: HostOption[]
  target: DevTarget
  buildMenuItems: (name: string) => MenuProps['items']
  onRetarget: (next: DevTarget) => void
  onDiagnose: (name: string, at?: DevTarget, refresh?: boolean) => Promise<void>
  onInstall: (name: string) => Promise<void>
  onShim: (name: string, at?: DevTarget) => Promise<void>
  onUnshim: (name: string) => Promise<void>
  onBuild: (name: string, at?: DevBuildTarget) => Promise<void>
  onClose: () => void
}

export default function DevDiagnosisModal({
  report, busy, hosts, target, buildMenuItems,
  onRetarget, onDiagnose, onInstall, onShim, onUnshim, onBuild, onClose,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  /** Where a resolved reference came from (monorepo vs host-provided). */
  const rootLabel = (root: DevResolveRoot | undefined): string => t(`plugin.dev.root.${root ?? 'monorepo'}`)

  /** How one resolved reference reads. "Missing" (nothing has it) and "dangling"
   * (the directory entry is there but its link target is gone) are different
   * problems with different fixes, so they never share a tag. */
  const resolveTag = (
    hit: { dir?: string; root?: DevResolveRoot; state?: DevResolveState; link?: string },
    peer = false,
  ): JSX.Element => {
    const verdict = resolveDescriptor(hit, peer)
    if (verdict.kind === 'missing') return <Tag color="error">{t('plugin.dev.diagMissing')}</Tag>
    if (verdict.kind === 'dangling') {
      return (
        <Tooltip title={hit.link !== undefined ? t('plugin.dev.diagDanglingHint', { target: verdict.target }) : verdict.target}>
          <Tag color="warning">{t('plugin.dev.diagDangling')}</Tag>
        </Tooltip>
      )
    }
    return <Tag color={verdict.root === 'monorepo' ? 'geekblue' : verdict.peer ? 'orange' : 'success'}>{rootLabel(verdict.root)}</Tag>
  }

  const profileOptions = (hostId: string | undefined): { value: string; label: string }[] => {
    const host = hosts.find(h => h.id === hostId)
    return [
      { value: '', label: t('plugin.dev.profileNone') },
      ...(host?.profiles ?? []).map(p => ({ value: p, label: p })),
    ]
  }

  // The chain this report belongs to — shown beside it, because a verdict does not
  // carry its own provenance.
  const scope = scopeLabel(report?.diag.meta, hosts)

  return (
    <ScrollModal
      title={t('plugin.dev.diagTitle', { name: report?.name ?? '' })}
      open={report !== null}
      onCancel={onClose}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
      width={MODAL.wide}
      bodyMax="lg"
    >
      {report !== null && (
        <Space orientation="vertical" size="small" style={{ width: '100%' }}>
          <Space size={8} wrap>
            <Tooltip title={t('plugin.dev.hostHint')}>
              <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
                {t('plugin.dev.hostSource')}
              </span>
            </Tooltip>
            <Select
              size="small"
              style={{ minWidth: 180 }}
              value={target.dshId}
              placeholder={t('plugin.dev.hostNone')}
              disabled={hosts.length === 0}
              onChange={value => onRetarget({ dshId: value })}
              options={hosts.map(h => ({ value: h.id, label: hostLabel(h) }))}
            />
            <Select
              size="small"
              style={{ minWidth: 140 }}
              value={target.profile ?? ''}
              disabled={target.dshId === undefined}
              onChange={value => onRetarget({ dshId: target.dshId, ...(value !== '' ? { profile: value } : {}) })}
              options={profileOptions(target.dshId)}
            />
            <Button size="small" loading={busy === `diag:${report.name}`} onClick={() => void onDiagnose(report.name, target, true)}>
              {t('plugin.dev.rediagnose')}
            </Button>
            {scope !== null && (
              <span style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>{t(scope.key, scope.params)}</span>
            )}
          </Space>
          {report.diag.index.conflicts.length > 0 && (
            <Alert
              type="error"
              showIcon
              title={t('plugin.dev.diagConflicts')}
              description={report.diag.index.conflicts
                .map(c => `${c.id} → ${c.names.join(' / ')}（${c.sources.join(', ')}）`).join(' · ')}
            />
          )}
          <div>
            <FieldLabel>{t('plugin.dev.diagEntry')}</FieldLabel>
            {report.diag.entryMissing
              ? <Tag color="error">{t('plugin.dev.diagEntryMissing')}</Tag>
              : <span style={{ fontFamily: 'monospace', fontSize: token.fontSizeSM }}>{report.diag.entry ?? '-'}</span>}
          </div>
          <div>
            <FieldLabel>{t('plugin.dev.diagPatchRows')}</FieldLabel>
            {report.diag.patchRows.length === 0
              ? <span style={{ color: token.colorTextSecondary }}>{t('plugin.dev.diagNoPatch')}</span>
              : report.diag.patchRows.map(r => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', flexWrap: 'wrap' }}>
                  <Tag style={{ fontFamily: 'monospace' }}>{r.id}</Tag>
                  <span style={{ fontFamily: 'monospace', fontSize: token.fontSizeSM }}>{r.name === '' ? '-' : r.name}</span>
                  {r.nameFrom === 'index' && r.from !== undefined && (
                    <Tooltip title={t('plugin.dev.diagInferredHint')}>
                      <Tag color="blue">{t('plugin.dev.diagInferred', { source: r.from })}</Tag>
                    </Tooltip>
                  )}
                  {r.pkg !== undefined && <Tag>{t('plugin.dev.diagSubpath')}</Tag>}
                  {r.name === '' ? null : resolveTag(r)}
                  {r.profileDir !== undefined && (
                    <Tooltip title={r.profileDir}>
                      <Tag color="cyan">{t('plugin.dev.diagInProfile')}</Tag>
                    </Tooltip>
                  )}
                </div>
              ))}
          </div>
          <div>
            <FieldLabel>{t('plugin.dev.diagPeers')}</FieldLabel>
            {report.diag.peers.length === 0
              ? <span style={{ color: token.colorTextSecondary }}>-</span>
              : report.diag.peers.map(peer => (
                <div key={peer.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: token.fontSizeSM }}>{peer.name}</span>
                  {resolveTag(peer, true)}
                  {report.diag.shimmed.includes(peer.name) && <Tag color="gold">{t('plugin.dev.diagShimmed')}</Tag>}
                </div>
              ))}
          </div>
          <Alert type="info" showIcon title={t('plugin.dev.fixHint')} />
          <Space wrap>
            <Button loading={busy === `install:${report.name}`} onClick={() => void onInstall(report.name)}>{t('plugin.dev.fixInstall')}</Button>
            <Button loading={busy === `shim:${report.name}`} onClick={() => void onShim(report.name, { dshId: report.diag.meta.dshId, profile: report.diag.meta.profile })}>{t('plugin.dev.fixShim')}</Button>
            {report.diag.shimmed.length > 0 && (
              <Button loading={busy === `unshim:${report.name}`} onClick={() => void onUnshim(report.name)}>{t('plugin.dev.fixUnshim')}</Button>
            )}
            <Dropdown.Button
              loading={busy === `build:${report.name}`}
              onClick={() => void onBuild(report.name)}
              menu={{ items: buildMenuItems(report.name), onClick: ({ key }) => void onBuild(report.name, parseBuildKey(key)) }}
            >
              {t('plugin.dev.build')}
            </Dropdown.Button>
          </Space>
        </Space>
      )}
    </ScrollModal>
  )
}
