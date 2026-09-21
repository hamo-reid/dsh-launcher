/** Edit a skill's markdown, with its frontmatter header previewed live. */
import { Suspense, lazy } from 'react'
import { Modal, Space, Tag, Typography, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { liveHeader } from '../../../lib/skillFrontmatter.ts'
import { SKILL_NAME_RE } from '../../../../../shared/skill.ts'

const CodeEditor = lazy(() => import('../../../components/CodeEditor.tsx'))

export interface SkillEditorModalProps {
  open: boolean
  /** The name being edited, or `null` when creating. */
  previousName: string | null
  text: string
  saving: boolean
  onChange: (text: string) => void
  onCancel: () => void
  onSubmit: () => void
}

export function SkillEditorModal(props: SkillEditorModalProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const header = liveHeader(props.text)
  const nameValid = header.name === undefined || SKILL_NAME_RE.test(header.name)

  return (
    <Modal
      open={props.open}
      title={props.previousName === null ? t('ext.skills.editorTitleNew') : t('ext.skills.editorTitle', { name: props.previousName })}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={props.saving}
      onOk={props.onSubmit}
      onCancel={props.onCancel}
      width={760}
      destroyOnHidden
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {header.name !== undefined ? (
            <>
              <Typography.Text code>{header.name}</Typography.Text>
              {!nameValid && <Tag color="error">{t('ext.skills.nameInvalid')}</Tag>}
              {header.description !== undefined && (
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }} ellipsis>
                  {header.description}
                </Typography.Text>
              )}
            </>
          ) : (
            <Typography.Text type="warning" style={{ fontSize: token.fontSizeSM }}>
              {t('ext.skills.liveInvalid')}
            </Typography.Text>
          )}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {t('ext.skills.editorHint')}
        </Typography.Text>
        <Suspense fallback={<div style={{ height: 360 }} />}>
          <CodeEditor value={props.text} language="plaintext" onChange={props.onChange} height={360} />
        </Suspense>
      </Space>
    </Modal>
  )
}
