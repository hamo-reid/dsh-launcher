/**
 * Skills for one dsh (dsh-scoped, not per-profile).
 *
 * The listing mirrors what dsh's `skill-filesystem` provider discovers: every
 * root in rank order, with the writable user-dsh root (`<dshHome>/skills`) as
 * the only place the launcher creates, edits, or deletes entries. A delete
 * moves the entry to the OS recycle bin; files dsh would silently ignore are
 * surfaced as issues instead.
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Empty, Popconfirm, Skeleton, Space, Tag, Tooltip, Typography, theme, message } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import Panel from '../components/Panel.tsx'
import Toolbar from '../components/Toolbar.tsx'
import { SkillEditorModal, SkillNameModal } from './ExtensionsModals.tsx'
import type { SkillEntry, SkillListing } from '../../../shared/types.ts'

/** Tag colour per root origin. */
const SOURCE_COLOUR: Record<SkillEntry['source'], string> = {
  'user-dsh': 'blue',
  'user-agents': 'purple',
  custom: 'orange',
  bundled: 'default',
}

/** Source label key suffix (`ext.skills.source.<suffix>`). */
const SOURCE_KEY: Record<SkillEntry['source'], 'userDsh' | 'userAgents' | 'custom' | 'bundled'> = {
  'user-dsh': 'userDsh',
  'user-agents': 'userAgents',
  custom: 'custom',
  bundled: 'bundled',
}

interface EditorState {
  open: boolean
  /** The name being edited, or `null` when creating. */
  previousName: string | null
  text: string
}

export default function SkillsView(props: { dshId?: string }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [listing, setListing] = useState<SkillListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [nameModal, setNameModal] = useState(false)
  const [editor, setEditor] = useState<EditorState>({ open: false, previousName: null, text: '' })

  const { dshId } = props

  const load = useCallback(async (): Promise<void> => {
    if (dshId === undefined) { setListing(null); return }
    setLoading(true)
    const r = await window.api.ext.skillList(dshId)
    setLoading(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setListing(r.value)
  }, [dshId])

  useEffect(() => { void load() }, [load])

  const create = async (name: string): Promise<void> => {
    if (dshId === undefined) return
    setNameModal(false)
    const r = await window.api.ext.skillScaffold(name)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setEditor({ open: true, previousName: null, text: r.value })
  }

  const openEdit = async (entry: SkillEntry): Promise<void> => {
    if (dshId === undefined) return
    setBusy(`edit:${entry.name}`)
    const r = await window.api.ext.skillRead(dshId, entry.name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setEditor({ open: true, previousName: entry.name, text: r.value.text })
  }

  const save = async (): Promise<void> => {
    if (dshId === undefined) return
    setBusy('save')
    const r = await window.api.ext.skillSave(dshId, editor.previousName, editor.text)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.skills.saved', { name: r.value.name }))
    setEditor({ open: false, previousName: null, text: '' })
    await load()
  }

  const remove = async (entry: SkillEntry): Promise<void> => {
    if (dshId === undefined) return
    setBusy(`remove:${entry.name}`)
    const r = await window.api.ext.skillDelete(dshId, entry.name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.skills.deleted', { name: entry.name }))
    await load()
  }

  const importZip = async (): Promise<void> => {
    if (dshId === undefined) return
    setBusy('import')
    const r = await window.api.ext.skillImportZip(dshId)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    if (r.value === null) return // dialog cancelled — not an error
    void message.success(t('ext.skills.imported', { names: r.value.map(entry => entry.name).join(', ') }))
    await load()
  }

  const skills = listing?.skills ?? []
  const issues = listing?.issues ?? []
  const roots = listing?.roots ?? []
  const writable = roots.find(root => root.writable)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Toolbar>
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          disabled={dshId === undefined}
          onClick={() => setNameModal(true)}
        >
          {t('ext.skills.add')}
        </Button>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t('common.refresh')}
        </Button>
        <Button
          size="small"
          icon={<UploadOutlined />}
          loading={busy === 'import'}
          disabled={dshId === undefined}
          onClick={() => void importZip()}
        >
          {t('ext.skills.import')}
        </Button>
        <span style={{ flex: 1 }} />
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {t('ext.skills.rootsHint')}
        </Typography.Text>
      </Toolbar>

      {dshId === undefined ? (
        <Empty style={{ marginTop: 48 }} description={t('ext.target.noDsh')} />
      ) : (
        <>
          <div style={{ padding: `${token.paddingXS}px ${token.padding}px 0` }}>
            {writable !== undefined && (
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                {t('ext.skills.writableRoot')}: <Typography.Text code style={{ fontSize: token.fontSizeSM }}>{writable.path}</Typography.Text>
              </Typography.Text>
            )}
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: token.padding }}>
            {loading && listing === null ? (
              <Skeleton active />
            ) : skills.length === 0 && issues.length === 0 ? (
              <Empty description={t('ext.skills.empty')} />
            ) : (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {issues.map((issue, i) => (
                  <Alert
                    key={i}
                    type="warning"
                    showIcon
                    title={t('ext.skills.issueTitle')}
                    description={(
                      <div>
                        <Typography.Text code style={{ fontSize: token.fontSizeSM }}>{issue.path}</Typography.Text>
                        <div style={{ marginTop: 2 }}>{issue.reason}</div>
                      </div>
                    )}
                  />
                ))}
                <Panel pad>
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                    {skills.map(entry => (
                      <div
                        key={`${entry.source}:${entry.path}`}
                        style={{
                          border: `1px solid ${token.colorSplit}`,
                          borderRadius: token.borderRadius,
                          padding: token.paddingSM,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <Typography.Text strong>{entry.name}</Typography.Text>
                          <Tag color={SOURCE_COLOUR[entry.source]}>{t(`ext.skills.source.${SOURCE_KEY[entry.source]}`)}</Tag>
                          {entry.shape === 'flat' && <Tag>{t('ext.skills.shape.flat')}</Tag>}
                          {!entry.modelInvocable && <Tag color="default">{t('ext.skills.invocation.modelOff')}</Tag>}
                          {!entry.userInvocable && <Tag color="default">{t('ext.skills.invocation.userOff')}</Tag>}
                          {!entry.editable && <Tag color="default">{t('ext.skills.readonly')}</Tag>}
                          <span style={{ flex: 1 }} />
                          <Button
                            size="small"
                            icon={<EditOutlined />}
                            disabled={!entry.editable}
                            loading={busy === `edit:${entry.name}`}
                            onClick={() => void openEdit(entry)}
                          />
                          <Popconfirm
                            title={t('ext.skills.deleteConfirm', { name: entry.name })}
                            okText={t('common.delete')}
                            cancelText={t('common.cancel')}
                            onConfirm={() => void remove(entry)}
                          >
                            <Button
                              size="small"
                              danger
                              icon={<DeleteOutlined />}
                              disabled={!entry.editable}
                              loading={busy === `remove:${entry.name}`}
                            />
                          </Popconfirm>
                        </div>
                        <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, marginTop: 4 }}>
                          {entry.description}
                        </div>
                        {entry.whenToUse !== undefined && (
                          <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, marginTop: 2 }}>
                            {t('ext.skills.whenToUse')}: {entry.whenToUse}
                          </div>
                        )}
                        <Tooltip title={entry.path}>
                          <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, marginTop: 2 }}>
                            {entry.path}
                          </div>
                        </Tooltip>
                      </div>
                    ))}
                  </Space>
                </Panel>
              </Space>
            )}
          </div>
        </>
      )}

      <SkillNameModal
        open={nameModal}
        onCancel={() => setNameModal(false)}
        onSubmit={name => void create(name)}
      />

      <SkillEditorModal
        open={editor.open}
        previousName={editor.previousName}
        text={editor.text}
        saving={busy === 'save'}
        onChange={text => setEditor(prev => ({ ...prev, text }))}
        onCancel={() => setEditor({ open: false, previousName: null, text: '' })}
        onSubmit={() => void save()}
      />
    </div>
  )
}
