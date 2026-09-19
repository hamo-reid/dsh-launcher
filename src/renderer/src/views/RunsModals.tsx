/** Modal dialogs for the Run page — pulled out of `RunsSection` so the page body
 * stays about the run list + console, not modal markup. */

import { Alert, Modal, Space, theme } from 'antd'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { MODAL } from '../theme.ts'
import type { InsertConflictLayer } from '../../../shared/types.ts'
import type { RunConflictInfo, RunFailInfo } from './useRuns.tsx'

interface RunFailModalProps {
  failInfo: RunFailInfo | null
  onClose: () => void
}

/** Surfaces an unexpected run exit: exit code, EADDRINUSE hint, launch command
 * and the buffered output. */
export function RunFailModal(p: RunFailModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const signalSuffix = p.failInfo?.signal != null ? `, ${p.failInfo.signal}` : ''
  return (
    <Modal title={t('run.failTitle')} open={p.failInfo !== null} okText={t('common.ok')} onOk={p.onClose} onCancel={p.onClose} width={MODAL.wide}>
      <Space orientation="vertical" style={{ width: '100%' }} size="middle">
        <Alert type="error" showIcon title={t('run.exited', { code: p.failInfo?.code ?? '?', signalSuffix })} />
        {p.failInfo?.eaddrinuse != null && (
          <Alert type="warning" showIcon
            title={t('run.portInUse', { port: p.failInfo.eaddrinuse[2], addr: p.failInfo.eaddrinuse[1] })}
            description={t('run.portInUseDesc')} />
        )}
        {p.failInfo?.command !== undefined && (
          <div>
            <div style={{ marginBottom: 6, fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>{t('run.commandLabel')}</div>
            <pre style={{ margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM, color: token.colorText, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: token.colorFillTertiary, padding: token.paddingSM, borderRadius: token.borderRadius }}>
              {p.failInfo.command}
            </pre>
          </div>
        )}
        <pre style={{ maxHeight: 360, overflowY: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
          {p.failInfo?.logs !== undefined && p.failInfo.logs !== '' ? p.failInfo.logs : t('run.noOutput')}
        </pre>
      </Space>
    </Modal>
  )
}

interface RunConflictModalProps {
  info: RunConflictInfo | null
  onClose: () => void
}

/** A launch refused because two layers of the profile insert the same loader
 * entry id (the host would fail with `duplicate loader entry id`): the offending
 * bundles and the colliding plugin ids, shown as two lists. */
export function RunConflictModal(p: RunConflictModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const conflicts = p.info?.conflicts ?? []

  const layerLabel = (layer: InsertConflictLayer): string => {
    if (layer.source === 'bundle') return t('profile.layer.bundle', { name: layer.bundle ?? '' })
    if (layer.source === 'profile') return t('profile.layer.profile', { name: layer.label ?? '' })
    if (layer.source === 'home') return t('profile.layer.home')
    return t('profile.detail.patchLayer', { name: layer.label ?? '' })
  }
  const layerKey = (layer: InsertConflictLayer): string => `${layer.source}:${layer.bundle ?? layer.label ?? ''}`

  // Distinct layers involved in any conflict, then the distinct colliding ids.
  const layers = [...new Map(conflicts.flatMap(c => c.layers).map(l => [layerKey(l), l])).values()]
  const ids = [...new Set(conflicts.map(c => c.id))].sort()

  const mono: CSSProperties = {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: token.fontSizeSM,
    wordBreak: 'break-all',
  }
  const listBox: CSSProperties = {
    maxHeight: 220,
    overflowY: 'auto',
    background: token.colorFillTertiary,
    padding: token.paddingSM,
    borderRadius: token.borderRadius,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  }

  return (
    <Modal title={t('run.insertConflictTitle')} open={p.info !== null} okText={t('common.ok')} onOk={p.onClose} onCancel={p.onClose} width={MODAL.wide}>
      <Space orientation="vertical" style={{ width: '100%' }} size="middle">
        <Alert
          type="error"
          showIcon
          title={t('run.insertConflictIntro', { profile: p.info?.profile ?? '' })}
          description={t('run.insertConflictDesc')}
        />
        <div>
          <div style={{ marginBottom: 6, fontWeight: 600 }}>{t('run.insertConflictBundles', { count: layers.length })}</div>
          <div style={listBox}>
            {layers.map(layer => <div key={layerKey(layer)} style={mono}>{layerLabel(layer)}</div>)}
          </div>
        </div>
        <div>
          <div style={{ marginBottom: 6, fontWeight: 600 }}>{t('run.insertConflictPlugins', { count: ids.length })}</div>
          <div style={listBox}>
            {ids.map(id => <div key={id} style={mono}>{id}</div>)}
          </div>
        </div>
      </Space>
    </Modal>
  )
}
