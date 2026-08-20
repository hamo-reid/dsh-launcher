import { useCallback, useEffect, useState } from 'react'
import {
  Alert, Button, Checkbox, Modal, Segmented, Select, Space, Typography, theme, message,
} from 'antd'
import { CaretRightOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import AppShell from '../components/AppShell.tsx'
import EmptyState from '../components/EmptyState.tsx'
import NavList from '../components/NavList.tsx'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
import ProfileDetailView from './ProfileDetail.tsx'
import RunConsole from '../components/RunConsole.tsx'
import { useRunRuntime } from './useRunRuntime.tsx'
import { useTrash } from './useTrash.ts'
import TrashPanel from './TrashPanel.tsx'
import {
  CloneProfileModal, CreateProfileModal, ExportProfileModal, ImportProfileModal, MirrorProfileModal, RunFailModal,
} from './ProfileModals.tsx'
import { LAYOUT } from '../theme.ts'
import type { TrashItem } from '../../../shared/types.ts'

interface ProfileSummary {
  name: string
  bundles: number
  plugins: number
  patchRows: number
}

type View = 'profiles' | 'trash'

const OFFICIAL_BASE = 'template:base'
const OFFICIAL_WEB = 'template:web'

/** Profile 页：Profile 实例 + 垃圾站 两种视图。运行控制台协调在
 * `useRunRuntime`，回收站状态在 `useTrash`，弹窗在 `ProfileModals`。 */
export default function ProfileSection() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const run = useRunRuntime()
  const trash = useTrash()
  const [view, setView] = useState<View>('profiles')

  const [summaries, setSummaries] = useState<ProfileSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [missing, setMissing] = useState<string[]>([])

  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createTemplate, setCreateTemplate] = useState(OFFICIAL_BASE)

  const [cloneTarget, setCloneTarget] = useState<string | null>(null)
  // Profile 迁移（复制到其他 DSH）：选中 profile 名。
  const [mirrorTarget, setMirrorTarget] = useState<string | null>(null)
  const [cloneName, setCloneName] = useState('')
  const [exportText, setExportText] = useState<string | null>(null)
  const [exportName, setExportName] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importJson, setImportJson] = useState('')
  const [importDefaultName, setImportDefaultName] = useState('')
  const [importUnpack, setImportUnpack] = useState('')
  const [importDshVersion, setImportDshVersion] = useState('')

  // 顶部 DSH 选择：选 active dsh，profiles 随该 dsh 的 home 刷新
  const [dshes, setDshes] = useState<{ id: string; name: string }[]>([])
  const [activeDshId, setActiveDshId] = useState<string>()
  const [activeDshVersion, setActiveDshVersion] = useState('')

  useEffect(() => {
    void (async () => {
      const r = await window.api.dsh.list()
      if (r.ok) {
        setDshes(r.value.dshes)
        setActiveDshId(r.value.activeDshId)
        setActiveDshVersion(r.value.dshes.find(d => d.id === r.value.activeDshId)?.version ?? '')
      }
    })()
  }, [])

  const changeDsh = async (id: string): Promise<void> => {
    if (id === activeDshId) return
    const name = dshes.find(d => d.id === id)?.name ?? id
    const r = await window.api.dsh.setActive(id)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setActiveDshId(id)
    setSelected(null) // 换 home 后旧选中的 profile 不再有效
    const l = await window.api.dsh.list()
    if (l.ok) setActiveDshVersion(l.value.dshes.find(d => d.id === l.value.activeDshId)?.version ?? '')
    void message.success(t('profile.switchedDsh', { name }))
    await refresh()
  }

  const refresh = useCallback(async (): Promise<void> => {
    const res = await window.api.listProfileSummaries()
    if (res.ok) setSummaries(res.value)
    else void message.error(apiErrorText(res))
    setLoading(false)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (selected === null) { setMissing([]); return }
    let alive = true
    void window.api.missingBundles(selected).then(result => {
      if (result.ok && alive) setMissing(result.value)
    })
    return () => { alive = false }
  }, [selected])

  const doCreate = async (): Promise<void> => {
    const n = createName.trim()
    if (n === '') return
    const res = await window.api.createProfile(n, createTemplate)
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    setCreateOpen(false)
    setCreateName('')
    setCreateTemplate(OFFICIAL_BASE)
    void message.success(t('profile.created'))
    setSelected(n)
    await refresh()
  }

  const doClone = async (): Promise<void> => {
    if (cloneTarget === null) return
    const n = cloneName.trim()
    if (n === '') { void message.warning(t('profile.clone.needName')); return }
    const res = await window.api.cloneProfile(cloneTarget, n)
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    setCloneTarget(null)
    setCloneName('')
    void message.success(t('profile.cloned'))
    await refresh()
  }

  const doDelete = async (name: string): Promise<void> => {
    const res = await window.api.deleteProfile(name)
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    if (selected === name) setSelected(null)
    void message.success(t('profile.movedToTrash'))
    await refresh()
    await trash.load()
  }

  const doExport = async (name: string): Promise<void> => {
    const res = await window.api.exportProfile(name)
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    setExportName(name)
    setExportText(res.value)
  }

  const doExportSave = async (name: string): Promise<void> => {
    if (name === '') return
    const lb = await window.api.localBundles(name)
    if (!lb.ok) { void message.error(lb.error); return }
    const stream = async (zip: boolean): Promise<void> => {
      const res = await window.api.exportToFile(name, zip ? { zip: true } : undefined)
      if (!res.ok) { void message.error(apiErrorText(res)); return }
      if (res.value === '') return // 用户取消保存
      void message.success(t('profile.exportedTo', { path: res.value }))
    }
    if (lb.value.length === 0) { await stream(false); return }
    Modal.confirm({
      title: t('profile.export.zipPromptTitle'),
      content: (
        <div>
          <div>{t('profile.export.zipPromptCount', { count: lb.value.length })}</div>
          <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', wordBreak: 'break-all', marginTop: 6 }}>
            {lb.value.join('、')}
          </div>
          <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, marginTop: 8 }}>
            {t('profile.export.zipPromptHint')}
          </div>
        </div>
      ),
      okText: t('profile.export.zipOk'),
      cancelText: t('profile.export.jsonCancel'),
      onOk: () => void stream(true),
      onCancel: () => void stream(false),
    })
  }

  const doImportFile = async (): Promise<void> => {
    const res = await window.api.importFromFile()
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    if (res.value.json === '') return // 用户取消选择
    setImportJson(res.value.json)
    setImportDefaultName(res.value.name || '')
    setImportUnpack(res.value.unpackDir)
    setImportDshVersion(res.value.dshVersion)
    setImportOpen(true)
  }

  // Import itself runs inside the dialog (per-step progress + final status);
  // on success we just refresh + select, leaving the dialog open so the user can
  // review the result and close it manually with「Done」.
  const onImported = (name: string): void => {
    setSelected(name)
    void refresh()
    if (view !== 'profiles') setView('profiles')
  }

  const loadMissing = (name: string): void => {
    void window.api.missingBundles(name).then(result => {
      if (result.ok) setMissing(result.value)
    })
  }

  const handleAction = (summary: ProfileSummary, key: string): void => {
    if (key === 'clone') { setCloneTarget(summary.name); setCloneName('') }
    else if (key === 'migrate') { setMirrorTarget(summary.name) }
    else if (key === 'export') { void doExport(summary.name) }
    else if (key === 'delete') { void doDelete(summary.name) }
  }

  const actionsFor = (summary: ProfileSummary): MenuAction[] => [
    { key: 'clone', label: t('profile.action.clone') },
    { key: 'migrate', label: t('profile.action.migrate') },
    { key: 'export', label: t('profile.action.export') },
    { key: 'delete', label: t('profile.action.softDelete'), danger: true, confirmText: t('profile.action.softDeleteConfirm', { name: summary.name }) },
  ]

  // ── 回收站 ─────────────────────────────────────────────────────────────
  const trashActionsFor = (item: TrashItem): MenuAction[] => [
    { key: 'restore', label: t('trash.restore') },
    { key: 'delete', label: t('trash.permanentlyDelete'), danger: true, confirmText: t('trash.action.deleteConfirm', { name: item.name }) },
  ]

  const handleTrashAction = (item: TrashItem, key: string): void => {
    if (key === 'restore') void trash.restore(item.name)
    else if (key === 'delete') void trash.remove(item.name)
  }

  const confirmEmpty = (): void => {
    Modal.confirm({
      title: t('trash.clearTitle'),
      content: t('trash.clearConfirm', { count: trash.items.length }),
      okText: t('trash.clear'),
      okButtonProps: { danger: true },
      onOk: () => void trash.emptyAll(),
    })
  }

  const trashSelected = trash.items.find(item => item.name === trash.selected)
  const createSources = [
    {
      label: t('profile.createSource.official'),
      options: [
        { value: OFFICIAL_BASE, label: t('profile.createSource.officialBase') },
        { value: OFFICIAL_WEB, label: t('profile.createSource.officialWeb') },
      ],
    },
    {
      label: t('profile.createSource.existing'),
      options: summaries.map(summary => ({ value: summary.name, label: t('profile.createSource.cloneFrom', { name: summary.name }) })),
    },
  ]

  return (
    <>
    <AppShell
      flush
      sider={
        <>
          <div style={{ padding: '8px 12px' }}>
            <Segmented
              block
              size="small"
              value={view}
              onChange={value => setView(value as View)}
              options={[{ value: 'profiles', label: t('profile.view.profiles') }, { value: 'trash', label: t('profile.view.trash') }]}
            />
          </div>

          {view === 'profiles' && (
            <div style={{ padding: 12 }}>
              <div style={{ marginBottom: 6, color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>{t('profile.useDsh')}</div>
              <Select
                value={activeDshId}
                onChange={id => void changeDsh(String(id))}
                style={{ width: '100%' }}
                placeholder={t('dsh.selectPlaceholder')}
                options={dshes.map(d => ({ value: d.id, label: d.name }))}
              />
              <Button type="primary" block style={{ marginTop: 10 }} disabled={activeDshId === undefined} onClick={() => setCreateOpen(true)}>
                {t('profile.newProfile')}
              </Button>
              <Button block style={{ marginTop: 8 }} disabled={activeDshId === undefined} onClick={() => void doImportFile()}>
                {t('profile.importFromFile')}
              </Button>
            </div>
          )}

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {view === 'profiles' && (
              <NavList
                items={summaries}
                keyOf={summary => summary.name}
                selectedKey={selected ?? undefined}
                onSelect={summary => setSelected(summary.name)}
                renderTitle={summary => summary.name}
                renderMeta={summary => t('profile.listMeta', { bundles: summary.bundles, plugins: summary.plugins, patch: summary.patchRows })}
                actions={summary => <ConfirmMenu actions={actionsFor(summary)} onAction={key => handleAction(summary, key)} />}
                loading={loading}
                empty={
                  <EmptyState
                    title={t('profile.empty.noProfiles')}
                    description={t('profile.empty.noProfilesDesc')}
                    action={<Button type="primary" disabled={activeDshId === undefined} onClick={() => setCreateOpen(true)}>{t('profile.newProfile')}</Button>}
                  />
                }
              />
            )}

            {view === 'trash' && (
              <NavList
                items={trash.items}
                keyOf={item => item.name}
                selectedKey={trash.selected}
                onSelect={item => trash.setSelected(item.name)}
                renderTitle={item => item.name}
                renderMeta={item => t('trash.listMeta', { bundles: item.bundles.length, deps: item.deps.length, patch: item.patchRows })}
                actions={item => <ConfirmMenu actions={trashActionsFor(item)} onAction={key => handleTrashAction(item, key)} />}
                empty={
                  <EmptyState
                    title={t('trash.empty.title')}
                    description={t('trash.empty.desc')}
                  />
                }
              />
            )}
          </div>

          {view === 'trash' && trash.items.length > 0 && (
            <div style={{ padding: '0 16px 16px' }}>
              <Button danger block onClick={confirmEmpty}>{t('trash.clearTitle')}</Button>
            </div>
          )}
        </>
      }
    >
      {view === 'profiles' && (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        {/* Fixed header: profile name + launch/stop. Shown whenever there is a
            selected profile OR a running process (a reload mid-run must keep the
            abort button visible even before any detail finishes loading). */}
        {(selected !== null || run.running) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: token.padding,
              background: token.colorBgContainer,
              padding: `${token.paddingSM}px ${LAYOUT.pagePaddingLG}px`,
              borderBottom: `1px solid ${token.colorBorder}`,
            }}
          >
            <Typography.Text strong style={{ fontSize: token.fontSizeLG }} ellipsis={{ tooltip: selected ?? undefined }}>
              {run.running && run.runningProfile !== undefined ? run.runningProfile : selected}
            </Typography.Text>
            <Space size={8}>
              <Checkbox checked={run.shellLaunch} onChange={e => run.setShellLaunch(e.target.checked)} disabled={run.running}>
                {t('run.shellMode')}
              </Checkbox>
              {run.running
                ? <Button danger onClick={() => void run.stopRun()}>{t('run.stop')}</Button>
                : <Button type="primary" icon={<CaretRightOutlined />} onClick={() => void (run.shellLaunch ? run.doLaunchShell(selected ?? '') : run.doLaunch(selected ?? ''))}>{t('run.start')}</Button>}
            </Space>
          </div>
        )}

        {/* Detail (scrolls) above, embedded console below. */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: LAYOUT.pagePaddingLG }}>
          {run.running && !run.shellLaunch ? (
            <div style={{ flex: 1, minHeight: 0 }}>
              <RunConsole logs={run.logs} running fill onUrlClick={run.openUrl} />
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              {missing.length > 0 && selected !== null && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message={t('profile.missingTitle', { list: missing.join('、') })}
                  description={t('profile.missingDesc', { profile: selected })}
                />
              )}
              {selected !== null
                ? <ProfileDetailView name={selected ?? run.runningProfile ?? ''} onChanged={() => { if (selected !== null) loadMissing(selected); void refresh() }} />
                : <EmptyState title={t('profile.selectProfile')} description={t('profile.selectProfileDesc')} />}
            </div>
          )}
        </div>
      </div>
      )}

      {view === 'trash' && (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: LAYOUT.pagePaddingLG, gap: 8 }}>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {trashSelected !== undefined
              ? <TrashPanel item={trashSelected} onRestore={name => void trash.restore(name)} onRemove={name => void trash.remove(name)} />
              : <EmptyState
                  title={trash.items.length === 0 ? t('trash.empty.title') : t('trash.selectProfile')}
                  description={trash.items.length === 0
                    ? t('trash.empty.desc')
                    : t('trash.selectProfileDesc')}
                />}
          </div>
        </div>
      )}
    </AppShell>

    <CreateProfileModal
      open={createOpen}
      name={createName}
      setName={setCreateName}
      template={createTemplate}
      setTemplate={setCreateTemplate}
      sources={createSources}
      onOk={() => void doCreate()}
      onCancel={() => setCreateOpen(false)}
    />
    <CloneProfileModal
      target={cloneTarget}
      name={cloneName}
      setName={setCloneName}
      onOk={() => void doClone()}
      onCancel={() => setCloneTarget(null)}
    />
    <ExportProfileModal
      text={exportText}
      name={exportName}
      onClose={() => setExportText(null)}
      onSave={name => void doExportSave(name)}
    />
    <ImportProfileModal
      open={importOpen}
      json={importJson}
      defaultName={importDefaultName}
      unpackDir={importUnpack}
      importDshVersion={importDshVersion}
      activeDshVersion={activeDshVersion}
      onClose={() => setImportOpen(false)}
      onImported={onImported}
    />
    <RunFailModal
      failInfo={run.failInfo}
      logs={run.logs}
      eaddrinuse={run.eaddrinuse}
      onClose={run.clearFail}
    />
    <MirrorProfileModal
      open={mirrorTarget !== null}
      sourceDshId={activeDshId ?? ''}
      profileName={mirrorTarget ?? ''}
      onClose={() => setMirrorTarget(null)}
      onMirrored={async () => { await refresh(); await trash.load() }}
    />
    </>
  )
}