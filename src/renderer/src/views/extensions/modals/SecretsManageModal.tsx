/** List the stored MCP launch secrets, with per-name clear. */
import { Button, Modal, Popconfirm, Space, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

export interface SecretsManageModalProps {
  open: boolean
  /** Stored environment-variable names. */
  names: string[]
  /** The name whose removal is in flight. */
  removing?: string
  onRemove: (name: string) => void
  /** Open the add-secret dialog on top of this one. */
  onAdd: () => void
  onClose: () => void
}

export function SecretsManageModal(props: SecretsManageModalProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <Modal
      open={props.open}
      title={t('ext.secrets.manageTitle')}
      footer={null}
      onCancel={props.onClose}
      width={520}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary">{t('ext.secrets.hint')}</Typography.Text>
        {props.names.length === 0 ? (
          <Typography.Text type="secondary">{t('ext.secrets.empty')}</Typography.Text>
        ) : (
          props.names.map(name => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Typography.Text code>{name}</Typography.Text>
              <span style={{ flex: 1 }} />
              <Popconfirm
                title={t('ext.secrets.removeConfirm', { name })}
                okText={t('common.delete')}
                cancelText={t('common.cancel')}
                onConfirm={() => props.onRemove(name)}
              >
                <Button size="small" danger icon={<DeleteOutlined />} loading={props.removing === name} />
              </Popconfirm>
            </div>
          ))
        )}
        <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={props.onAdd}>
          {t('ext.secrets.add')}
        </Button>
      </Space>
    </Modal>
  )
}

/** Ask for a new skill's name (the slug everything else derives from). */
