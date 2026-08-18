import { useEffect, useState } from 'react'
import {
  Button, Descriptions, Divider, Space, theme, Typography, message,
} from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import AppShell from '../components/AppShell.tsx'
import EmptyState from '../components/EmptyState.tsx'
import NavList from '../components/NavList.tsx'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
import FieldLabel from '../components/FieldLabel.tsx'
import ConfigRow from '../components/ConfigRow.tsx'
import Panel from '../components/Panel.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import { AddDshModal, DshRemoveModal, OfficialInstallModal, RenameDshModal } from './DshModals.tsx'

interface DshEntry {
  id: string
  name: string
  execPath: string
  version: string
  home: string
  launch?: string
  /** Effective (resolved) profile dir, computed in main. */
  profileDir?: string
  /** Configured profile-dir override, if any. */
  profilesDir?: string
  /** Directory holding this dsh's executable (for reveal in explorer). */
  dir?: string
}

/** DSH 页：安装(官方安装) + 管理(列表)；弹窗在 `DshModals`。套统一 AppShell。 */
export default function DshSection() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [dshes, setDshes] = useState<DshEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string>()
  const [homeInput, setHomeInput] = useState('')
  const [profileDirInput, setProfileDirInput] = useState('')

  const [officialOpen, setOfficialOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  // 重命名弹窗（已注册 DSH）
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)
  // 移除弹窗（可选删除文件）
  const [removeDsh, setRemoveDsh] = useState<{ id: string; name: string } | null>(null)

  const refresh = async (): Promise<void> => {
    const r = await window.api.dsh.list()
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setDshes(r.value.dshes)
    setActiveId(r.value.activeDshId)
    const active = r.value.dshes.find(d => d.id === r.value.activeDshId)
    setHomeInput(active?.home ?? '')
    setProfileDirInput(active?.profilesDir ?? '')
    setLoading(false)
  }

  useEffect(() => { void refresh() }, [])

  const activate = async (id: string, name: string): Promise<void> => {
    if (id === activeId) return
    const r = await window.api.dsh.setActive(id)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('dsh.activated', { name }))
    await refresh()
  }

  const saveHome = async (value: string): Promise<string> => {
    if (activeId === undefined) return t('dsh.noDshSelected')
    const r = await window.api.dsh.setHome(activeId, value)
    if (!r.ok) return apiErrorText(r)
    setHomeInput(value)
    await refresh()
    return ''
  }

  const saveProfileDir = async (value: string): Promise<string> => {
    if (activeId === undefined) return t('dsh.noDshSelected')
    const r = await window.api.dsh.setProfileDir(activeId, value)
    if (!r.ok) return apiErrorText(r)
    setProfileDirInput(value)
    await refresh()
    return ''
  }

  const revealDir = async (id: string): Promise<void> => {
    const r = await window.api.dsh.revealDir(id)
    if (!r.ok) void message.error(apiErrorText(r))
  }

  const actionsFor = (d: DshEntry): MenuAction[] => [
    { key: 'rename', label: t('dsh.action.rename') },
    { key: 'activate', label: t('dsh.action.setCurrent') },
    { key: 'remove', label: t('dsh.action.remove'), danger: true },
  ]

  const handleAction = (d: DshEntry, key: string): void => {
    if (key === 'rename') setRenameTarget({ id: d.id, name: d.name })
    else if (key === 'activate') void activate(d.id, d.name)
    else if (key === 'remove') setRemoveDsh({ id: d.id, name: d.name })
  }

  const active = dshes.find(d => d.id === activeId)

  return (
    <>
    <AppShell
      sider={
        <>
          <div style={{ padding: 12 }}>
            <FieldLabel>{t('dsh.section.install')}</FieldLabel>
            <Button type="primary" block onClick={() => setOfficialOpen(true)}>{t('dsh.section.officialInstall')}</Button>
          </div>

          <Divider style={{ margin: '4px 0' }} />

          <div style={{ padding: '0 16px' }}><FieldLabel>{t('dsh.section.manage')}</FieldLabel></div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <NavList
              items={dshes}
              keyOf={d => d.id}
              selectedKey={activeId}
              onSelect={d => void activate(d.id, d.name)}
              renderTitle={d => d.name}
              renderMeta={d => (
                <span
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    display: 'block',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={d.dir ?? d.execPath}
                >
                  {d.dir ?? d.execPath}
                </span>
              )}
              actions={d => <ConfirmMenu actions={actionsFor(d)} onAction={key => handleAction(d, key)} />}
              loading={loading}
              empty={<EmptyState title={t('dsh.empty.noDsh')} description={t('dsh.empty.noDshDesc')}/>}
            />
          </div>

          <div style={{ padding: '0 16px 16px' }}>
            <Button block onClick={() => setAddOpen(true)}>{t('dsh.section.add')}</Button>
          </div>
        </>
      }
    >
      {active !== undefined
        ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <SectionHeading title={active.name} />
            <Panel title={t('dsh.basicInfo')}>
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label={t('dsh.version')}>{active.version || t('common.unknown')}</Descriptions.Item>
                <Descriptions.Item label={t('dsh.launchCommand')}>
                  <Typography.Text copyable code style={{ wordBreak: 'break-all' }}>
                    {active.launch ?? active.execPath}
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label={t('dsh.location')}>
                  <Space size="small">
                    <Typography.Text copyable code style={{ wordBreak: 'break-all' }}>
                      {active.dir ?? active.execPath}
                    </Typography.Text>
                    <Button size="small" onClick={() => void revealDir(active.id)}>{t('dsh.reveal')}</Button>
                  </Space>
                </Descriptions.Item>
              </Descriptions>
            </Panel>
            <Panel title={t('dsh.dirConfig')}>
              <ConfigRow
                title={t('dsh.homeTitle')}
                description={t('dsh.homeDesc')}
                value={homeInput}
                onSave={saveHome}
              />
              <div style={{ margin: '10px 0', borderTop: `1px solid ${token.colorSplit}` }} />
              <ConfigRow
                title={t('dsh.profileDirTitle')}
                description={t('dsh.profileDirDesc')}
                value={profileDirInput}
                onSave={saveProfileDir}
              />
              <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
                {t('dsh.effectiveDir', { dir: active?.profileDir ?? '—' })}
              </div>
            </Panel>
          </Space>
        )
        : (loading
            ? undefined
            : <EmptyState title={t('dsh.select')} description={t('dsh.selectDesc')} />)}
    </AppShell>

    <OfficialInstallModal open={officialOpen} onClose={() => setOfficialOpen(false)} onDone={() => void refresh()} />
    <AddDshModal open={addOpen} onClose={() => setAddOpen(false)} onDone={() => void refresh()} />
    <RenameDshModal target={renameTarget} onClose={() => setRenameTarget(null)} onDone={() => void refresh()} />
    <DshRemoveModal dsh={removeDsh} onClose={() => setRemoveDsh(null)} onRemoved={() => void refresh()} />
    </>
  )
}