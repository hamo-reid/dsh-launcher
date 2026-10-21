/** Name a new skill: the name becomes a directory holding the scaffold, so it is
 * validated up front. What the launcher writes is only a starting point — the
 * card's open menu is how the skill is actually written from here on. */
import { useEffect, useState } from 'react'
import { Input, Modal, Space, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import FieldLabel from '../../../components/FieldLabel.tsx'
import { SKILL_NAME_RE } from '../../../../../shared/skill.ts'

interface SkillNameModalProps {
  open: boolean
  onCancel: () => void
  onSubmit: (name: string) => void
}

export function SkillNameModal(props: SkillNameModalProps): JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState('')

  useEffect(() => {
    if (props.open) setName('')
  }, [props.open])

  const valid = SKILL_NAME_RE.test(name)
  const submit = (): void => {
    if (valid) props.onSubmit(name)
  }

  return (
    <Modal
      open={props.open}
      title={t('ext.skills.nameTitle')}
      okText={t('common.ok')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: !valid }}
      onOk={submit}
      onCancel={props.onCancel}
      width={420}
      destroyOnHidden
    >
      <Space orientation="vertical" size={8} style={{ width: '100%' }}>
        <FieldLabel>{t('ext.skills.nameField')}</FieldLabel>
        <Input
          autoFocus
          value={name}
          placeholder="my-skill"
          status={name !== '' && !valid ? 'error' : undefined}
          onChange={e => setName(e.target.value)}
          onPressEnter={submit}
        />
        {name !== '' && !valid && (
          <Typography.Text type="danger" style={{ fontSize: 'inherit' }}>{t('ext.skills.nameInvalid')}</Typography.Text>
        )}
      </Space>
    </Modal>
  )
}
