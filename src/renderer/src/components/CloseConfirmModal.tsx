/** The close prompt: asked by the main process (`window:askClose`) when the
 * window closes and the user hasn't disabled asking. Choosing an action resolves
 * via `window:chooseClose`; ticking "don't ask again" persists that choice. */
import { useState } from 'react'
import { Alert, Checkbox, Modal, Space, theme } from 'antd'
import { CloudDownloadOutlined, LogoutOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { MODAL } from '../theme.ts'

interface CloseConfirmModalProps {
  open: boolean
  /** Name of a dsh profile the run-console is currently running, if any. */
  running?: string
  onClose: () => void
  onResolve: (action: 'tray' | 'quit', remember: boolean) => void | Promise<void>
}

export default function CloseConfirmModal(p: CloseConfirmModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [remember, setRemember] = useState(false)

  const resolve = (action: 'tray' | 'quit'): void => {
    // Close the prompt FIRST (synchronously) so it is gone the moment the chosen
    // action starts; the "tray" action hides the window immediately via IPC, and
    // an animation-driven close would wedge while the window is hidden.
    p.onClose()
    void p.onResolve(action, remember)
  }

  return (
    <Modal
      title={p.running !== undefined ? t('window.close.runningTitle') : t('window.close.title')}
      open={p.open}
      onCancel={p.onClose}
      footer={null}
      width={MODAL.narrow}
      destroyOnClose
      // No mount/close animation: resolving must collapse the modal instantly
      // even when the window is about to be hidden (rAF/transition are throttled
      // for a hidden window and would otherwise leave the prompt hanging).
      transitionName=""
      maskTransitionName=""
      maskClosable={false}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {p.running !== undefined && (
          <Alert type="warning" showIcon message={t('window.close.runningWarn', { profile: p.running })} />
        )}

        <Space direction="vertical" style={{ width: '100%' }}>
          <button
            type="button"
            onClick={() => resolve('tray')}
            style={{
              width: '100%', padding: '12px 14px', borderRadius: token.borderRadiusLG,
              border: `1px solid ${token.colorBorder}`, cursor: 'pointer', textAlign: 'left',
              background: token.colorBgContainer,
            }}
          >
            <Space>
              <CloudDownloadOutlined />
              <span>{t('window.close.toTray')}</span>
            </Space>
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: 4, paddingLeft: 24 }}>
              {t('window.close.toTrayDesc')}
            </div>
          </button>

          <button
            type="button"
            onClick={() => resolve('quit')}
            style={{
              width: '100%', padding: '12px 14px', borderRadius: token.borderRadiusLG,
              border: `1px solid ${token.colorBorder}`, cursor: 'pointer', textAlign: 'left',
              background: token.colorBgContainer,
            }}
          >
            <Space>
              <LogoutOutlined />
              <span>{t('window.close.quit')}</span>
            </Space>
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: 4, paddingLeft: 24 }}>
              {t('window.close.quitDesc')}
            </div>
          </button>
        </Space>

        <Checkbox checked={remember} onChange={e => setRemember(e.target.checked)}>
          {t('window.close.remember')}
        </Checkbox>
      </Space>
    </Modal>
  )
}