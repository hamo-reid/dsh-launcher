import { useEffect, useState } from 'react'
import {
  Button, Descriptions, Divider, Modal, Space, Tag, theme, Typography, message,
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
import { AddDshModal, DataMirrorModal, DshRemoveModal, OfficialInstallModal, RenameDshModal, UpdateDshModal } from './DshModals.tsx'
import { majorOfVersion } from '../../../shared/version.ts'
import type { DshEntry } from '../../../shared/types.ts'

/** DSH 页：安装(官方安装) + 管理(列表)；弹窗在 `DshModals`。套统一 AppShell。 */
export default function DshSection() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [dshes, setDshes] = useState<DshEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string>()
  const [homeInput, setHomeInput] = useState('')
  const [profileDirInput, setProfileDirInput] = useState('')
  // Exec paths that no longer exist on disk (stale = lacks the remove-guard).
  const [stalePaths, setStalePaths] = useState<Set<string>>(new Set())
  // Exec paths whose launch entry is unresolvable (incomplete install → repairable).
  const [brokenPaths, setBrokenPaths] = useState<Set<string>>(new Set())

  const [officialOpen, setOfficialOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  // 「修复/重新安装」目标：预填官方安装弹窗并强制覆盖（force 走删除同目录重装）。
  const [repairTarget, setRepairTarget] = useState<{ name: string } | null>(null)

  // 重命名弹窗（已注册 DSH）
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)
  // 移除弹窗（可选删除文件）
  const [removeDsh, setRemoveDsh] = useState<{ id: string; name: string } | null>(null)
  // 版本更新弹窗（app 管理的 DSH）
  const [updateDsh, setUpdateDsh] = useState<{ id: string; name: string } | null>(null)
  // 数据迁移弹窗（把当前 DSH 的 home 数据迁移到另一 DSH）
  const [mirrorOpen, setMirrorOpen] = useState(false)

  const refresh = async (): Promise<void> => {
    const r = await window.api.dsh.list()
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setDshes(r.value.dshes)
    setActiveId(r.value.activeDshId)
    const active = r.value.dshes.find(d => d.id === r.value.activeDshId)
    setHomeInput(active?.home ?? '')
    setProfileDirInput(active?.profilesDir ?? '')
    setLoading(false)
    // Track which dsh executables no longer exist (stale) or resolve to an
    // unresolvable launch entry (broken / incomplete → repairable).
    const h = await window.api.settings.checkHealth()
    if (h.ok) {
      setStalePaths(new Set(h.value.filter(x => x.kind === 'dsh-exec').map(x => x.path ?? '')))
      setBrokenPaths(new Set(h.value.filter(x => x.kind === 'dsh-broken').map(x => x.path ?? '')))
    }
  }

  useEffect(() => { void refresh() }, [])

  // 后台的 dsh 下载/更新会话（已在统一下载中心展示）结束后联动刷新列表，
  // 让新版本 / 新安装即时反映到 DSH 页。
  useEffect(() => {
    const off = window.api.downloads.onChange(list => {
      if (list.some(d => d.kind === 'dsh' && d.status === 'done')) void refresh()
    })
    return off
  }, [refresh])

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

  const isStale = (d: DshEntry): boolean => d.execPath !== '' && stalePaths.has(d.execPath)
  const isBroken = (d: DshEntry): boolean => d.execPath !== '' && brokenPaths.has(d.execPath)

  const actionsFor = (d: DshEntry): MenuAction[] => [
    { key: 'rename', label: t('dsh.action.rename') },
    { key: 'activate', label: t('dsh.action.setCurrent') },
    // app 管理的 dsh 可原地升级版本（checkUpdate / update）。
    ...(d.managed === true
      ? [{ key: 'update', label: t('dsh.action.update') } as MenuAction]
      : []),
    // 残缺（安装不完整）的 app 托管安装可「重新安装」修复。
    ...(isBroken(d) && d.managed === true
      ? [{ key: 'repair', label: t('dsh.action.repair') } as MenuAction]
      : []),
    // 失效条目（磁盘上可执行已不存在）允许脱管清理。
    ...(isStale(d)
      ? [{ key: 'remove-stale', label: t('dsh.action.removeStale'), danger: true } as MenuAction]
      : []),
    // 仅 app 管理的（官方安装）可删除；系统级/手动加入的用户全局 dsh 不给删除入口。
    ...(d.managed === true
      ? [{ key: 'remove', label: t('dsh.action.remove'), danger: true } as MenuAction]
      : []),
  ]

  const handleAction = (d: DshEntry, key: string): void => {
    if (key === 'rename') setRenameTarget({ id: d.id, name: d.name })
    else if (key === 'activate') void activate(d.id, d.name)
    else if (key === 'update') setUpdateDsh({ id: d.id, name: d.name })
    else if (key === 'repair') setRepairTarget({ name: d.name })
    else if (key === 'remove') setRemoveDsh({ id: d.id, name: d.name })
    else if (key === 'remove-stale') {
      Modal.confirm({
        title: t('dsh.action.removeStaleConfirmTitle'),
        content: t('dsh.action.removeStaleConfirm', { name: d.name, path: d.execPath }),
        okText: t('common.confirm'),
        okButtonProps: { danger: true },
        onOk: async () => {
          const r = await window.api.dsh.remove(d.id)
          if (!r.ok) void message.error(apiErrorText(r))
          else { void message.success(t('dsh.removed')); await refresh() }
        },
      })
    }
  }

  const active = dshes.find(d => d.id === activeId)

  const exportData = async (): Promise<void> => {
    if (activeId === undefined) return
    const r = await window.api.data.export(activeId)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    if (r.value === '') return
    void message.success(t('data.exported', { path: r.value }))
  }

  const importData = async (): Promise<void> => {
    if (activeId === undefined) return
    const entry = dshes.find(d => d.id === activeId)
    if (entry === undefined) return
    const r = await window.api.data.inspectImport()
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    if (r.value.file === '') return
    const from = r.value.manifest?.dshVersion
    const to = entry.version
    const ma = from !== undefined && from !== '' ? majorOfVersion(from) : -1
    const mb = to !== '' ? majorOfVersion(to) : -1
    const cross = ma > 0 && mb > 0 && ma !== mb
    const doImport = async (forceDsh: boolean): Promise<void> => {
      const res = await window.api.data.import(entry!.id, r.value.file, forceDsh)
      if (!res.ok) { void message.error(apiErrorText(res)); return }
      if (res.value.dshMismatch) { void message.warning(res.value.text); return }
      void message.success(res.value.text)
    }
    if (cross) {
      Modal.confirm({
        title: t('data.importConfirmTitle'),
        content: t('data.importCrossMajor', { from: from ?? '', to }),
        okText: t('data.forceImport'),
        onOk: () => void doImport(true),
      })
    } else {
      void doImport(false)
    }
  }

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
                  {isBroken(d) && <Tag color="error" style={{ marginInlineStart: 6 }}>{t('dsh.broken')}</Tag>}
                  {isStale(d) && <Tag color="error" style={{ marginInlineStart: 6 }}>{t('dsh.stale')}</Tag>}
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
          <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
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
            <Panel title={t('dsh.dataTitle')}>
              <div style={{ marginBottom: 8, color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
                {t('dsh.dataDesc')}
              </div>
              <Space wrap>
                <Button onClick={() => void exportData()}>{t('data.export')}</Button>
                <Button onClick={() => void importData()}>{t('data.import')}</Button>
                <Button onClick={() => setMirrorOpen(true)}>{t('data.mirror')}</Button>
              </Space>
            </Panel>
          </Space>
        )
        : (loading
            ? undefined
            : <EmptyState title={t('dsh.select')} description={t('dsh.selectDesc')} />)}
    </AppShell>

    <OfficialInstallModal
      open={officialOpen || repairTarget !== null}
      onClose={() => { setOfficialOpen(false); setRepairTarget(null) }}
      onDone={() => void refresh()}
      preset={repairTarget === null ? undefined : { name: repairTarget.name, force: true }}
    />
    <AddDshModal open={addOpen} onClose={() => setAddOpen(false)} onDone={() => void refresh()} />
    <RenameDshModal target={renameTarget} onClose={() => setRenameTarget(null)} onDone={() => void refresh()} />
    <DshRemoveModal dsh={removeDsh} onClose={() => setRemoveDsh(null)} onRemoved={() => void refresh()} />
    <UpdateDshModal dsh={updateDsh} onClose={() => setUpdateDsh(null)} onDone={() => void refresh()} />
    <DataMirrorModal
      open={mirrorOpen}
      source={active === undefined ? null : { id: active.id, name: active.name, version: active.version }}
      onClose={() => setMirrorOpen(false)}
      onDone={() => void refresh()}
    />
    </>
  )
}