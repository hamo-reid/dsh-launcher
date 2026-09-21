/** Set (or clear) one MCP launch secret's value. Only the name is ever shown. */
import { useEffect, useState } from 'react'
import { Input, Modal, Space } from 'antd'
import { useTranslation } from 'react-i18next'
import FieldLabel from '../../../components/FieldLabel.tsx'

export interface McpSecretModalProps {
  open: boolean
  saving: boolean
  onCancel: () => void
  onSave: (name: string, value: string) => void
}

export function McpSecretModal(props: McpSecretModalProps): JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')

  useEffect(() => {
    if (props.open) { setName(''); setValue('') }
  }, [props.open])

  const nameValid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim())
  const canSave = nameValid && value !== ''
  const submit = (): void => {
    if (!canSave) return
    props.onSave(name.trim(), value)
  }

  return (
    <Modal
      open={props.open}
      title={t('ext.secrets.addTitle')}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={props.saving}
      onOk={submit}
      onCancel={props.onCancel}
      width={480}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div style={{ color: 'inherit', fontSize: 'inherit' }}>
          {t('ext.secrets.addHint')}
        </div>
        <div>
          <FieldLabel>{t('ext.secrets.fieldName')}</FieldLabel>
          <Input
            value={name}
            placeholder="GITHUB_TOKEN"
            status={name !== '' && !nameValid ? 'error' : undefined}
            onChange={e => setName(e.target.value)}
          />
        </div>
        <div>
          <FieldLabel>{t('ext.secrets.fieldValue')}</FieldLabel>
          <Input.Password
            value={value}
            placeholder={t('ext.secrets.fieldValuePlaceholder')}
            onChange={e => setValue(e.target.value)}
          />
        </div>
      </Space>
    </Modal>
  )
}

/** Browse and manage the launcher's launch secrets: the list, add (opens
 * {@link McpSecretModal} on top), and per-name removal. */
