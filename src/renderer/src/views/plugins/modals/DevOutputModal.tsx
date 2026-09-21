/**
 * pnpm's output for a build / install, with the exact invocation shown so it can
 * be copied and re-run outside the launcher — the point of the dialog is that the
 * command is reproducible by hand.
 */
import { Button, Input, Modal, Space, Typography, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import FieldLabel from '../../../components/FieldLabel.tsx'
import { MODAL } from '../../../theme.ts'
import type { RunOutput } from '../useDevPlugins.ts'

interface Props {
  /** The last run; the dialog is open while this is set. */
  output: RunOutput | null
  onClose: () => void
}

export default function DevOutputModal({ output, onClose }: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  return (
    <Modal
      title={t(output?.ok === true ? 'plugin.dev.runOk' : 'plugin.dev.runFailed', { name: output?.name ?? '' })}
      open={output !== null}
      onCancel={onClose}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
      width={MODAL.wide}
    >
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        <div>
          <FieldLabel>{t('plugin.dev.runCwd')}</FieldLabel>
          <div style={{ fontFamily: 'monospace', fontSize: token.fontSizeSM, wordBreak: 'break-all' }}>{output?.cwd ?? ''}</div>
        </div>
        <div>
          <FieldLabel>{t('plugin.dev.runCommand')}</FieldLabel>
          <Typography.Text
            copyable={{ text: output?.command ?? '' }}
            code
            style={{ fontSize: token.fontSizeSM, wordBreak: 'break-all' }}
          >
            {output?.command ?? ''}
          </Typography.Text>
        </div>
        <Input.TextArea
          readOnly
          value={output?.text ?? ''}
          autoSize={{ minRows: 8, maxRows: 22 }}
          style={{ fontFamily: 'monospace', fontSize: token.fontSizeSM }}
        />
      </Space>
    </Modal>
  )
}
