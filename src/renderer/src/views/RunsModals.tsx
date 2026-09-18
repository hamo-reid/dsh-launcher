/** Modal dialogs for the Run page — pulled out of `RunsSection` so the page body
 * stays about the run list + console, not modal markup. */

import { Alert, Modal, Space, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { MODAL } from '../theme.ts'
import type { RunFailInfo } from './useRuns.tsx'

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
