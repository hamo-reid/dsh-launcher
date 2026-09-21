import { lazy, useCallback, useEffect, useState } from 'react'
import {
  Button, Modal, Segmented, Select, Tag, theme, message,
} from 'antd'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import AppShell from '../components/AppShell.tsx'
import EmptyState from '../components/EmptyState.tsx'
import NavList from '../components/NavList.tsx'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
// Profile detail is heavy (dnd-kit drag/drop) — lazy so it isn't in the first
// profile-screen parse. The App-level Suspense provides its loading fallback.
const ProfileDetailView = lazy(() => import('./ProfileDetail.tsx'))
import { useTrash } from './useTrash.ts'
import TrashPanel from './TrashPanel.tsx'
import {
  CloneProfileModal, CreateProfileModal, ExportProfileModal, ImportProfileModal, MirrorProfileModal,
} from './ProfileModals.tsx'
import { LAYOUT } from '../theme.ts'
import type { ProfileSummary, TrashItem } from '../../../shared/types.ts'

type View = 'profiles' | 'trash'

const OFFICIAL_BASE = 'template:base'
const OFFICIAL_WEB = 'template:web'

/** Profile 页：Profile 实例 + 垃圾站 两种视图。只负责 profile 的管理
 * （新建/克隆/导入导出/迁移/回收站）；运行与多进程控制台已迁至「运行」页
 * （`RunsSection`）。本页有自己的 DSH 选择——不依赖任何全局「当前 DSH」。 */
export default function ProfileSection() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [view, setView] = useState<View>('profiles')

  // 本页 DSH 选择（默认取第一个已注册的 dsh；不写全局状态）。
  const [dshes, setDshes] = useState<{ id: string; name: string; version: string }[]>([])
  const [dshId, setDshId] = useState<string>()
  const trash = useTrash(dshId)

  const [summaries, setSummaries] = useState<ProfileSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)

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

  useEffect(() => {
    void (async () => {
      const r = await window.api.dsh.list()
      if (!r.ok) return
      setDshes(r.value.dshes.map(d => ({ id: d.id, name: d.name, version: d.version })))
      setDshId(prev => (prev !== undefined && r.value.dshes.some(d => d.id === prev)) ? prev : r.value.dshes[0]?.id)
    })()
  }, [])

  const changeDsh = (id: string): void => {
    if (id === dshId) return
    setDshId(id)
    setSelected(null) // 换 home 后旧选中的 profile 不再有效
  }

  const refresh = useCallback(async (): Promise<void> => {
    if (dshId === undefined) { setSummaries([]); setLoading(false); return }
    const res = await window.api.listProfileSummaries(dshId)
    if (res.ok) setSummaries(res.value)
    else void message.error(apiErrorText(res))
    setLoading(false)
  }, [dshId])

  useEffect(() => { void refresh() }, [refresh])

  const doCreate = async (): Promise<void> => {
    if (dshId === undefined) return
    const n = createName.trim()
    if (n === '') return
    const res = await window.api.createProfile(dshId, n, createTemplate)
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    setCreateOpen(false)
    setCreateName('')
    setCreateTemplate(OFFICIAL_BASE)
    void message.success(t('profile.created'))
    setSelected(n)
    await refresh()
  }

  const doClone = async (): Promise<void> => {
    if (dshId === undefined || cloneTarget === null) return
    const n = cloneName.trim()
    if (n === '') { void message.warning(t('profile.clone.needName')); return }
    const res = await window.api.cloneProfile(dshId, cloneTarget, n)
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    setCloneTarget(null)
    setCloneName('')
    void message.success(t('profile.cloned'))
    await refresh()
  }

  const doDelete = async (name: string): Promise<void> => {
    if (dshId === undefined) return
    const res = await window.api.deleteProfile(dshId, name)
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    if (selected === name) setSelected(null)
    void message.success(t('profile.movedToTrash'))
    await refresh()
    await trash.load()
  }

  const doExport = async (name: string): Promise<void> => {
    if (dshId === undefined) return
    const res = await window.api.exportProfile(dshId, name)
    if (!res.ok) { void message.error(apiErrorText(res)); return }
    setExportName(name)
    setExportText(res.value)
  }

  const doExportSave = async (name: string): Promise<void> => {
    if (dshId === undefined || name === '') return
    const lb = await window.api.localBundles(dshId, name)
    if (!lb.ok) { void message.error(lb.error); return }
    const stream = async (zip: boolean): Promise<void> => {
      const res = await window.api.exportToFile(dshId, name, zip ? { zip: true } : undefined)
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
            {lb.value.join(t('common.listSep'))}
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
    // A live profile cannot be soft-deleted (the core refuses it too).
    ...(summary.running === true
      ? []
      : [{ key: 'delete', label: t('profile.action.softDelete'), danger: true, confirmText: t('profile.action.softDeleteConfirm', { name: summary.name }) } as MenuAction]),
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
      contentBg={token.colorBgContainer}
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

          <div style={{ padding: 12 }}>
            <div style={{ marginBottom: 6, color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>{t('profile.useDsh')}</div>
            <Select
              value={dshId}
              onChange={id => changeDsh(String(id))}
              style={{ width: '100%' }}
              placeholder={t('dsh.selectPlaceholder')}
              options={dshes.map(d => ({ value: d.id, label: d.name }))}
            />
            {view === 'profiles' && (
              <>
                <Button type="primary" block style={{ marginTop: 10 }} disabled={dshId === undefined} onClick={() => setCreateOpen(true)}>
                  {t('profile.newProfile')}
                </Button>
                <Button block style={{ marginTop: 8 }} disabled={dshId === undefined} onClick={() => void doImportFile()}>
                  {t('profile.importFromFile')}
                </Button>
              </>
            )}
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {view === 'profiles' && (
              <NavList
                items={summaries}
                keyOf={summary => summary.name}
                selectedKey={selected ?? undefined}
                onSelect={summary => setSelected(summary.name)}
                renderTitle={summary => (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {summary.name}
                    {summary.running === true && <Tag color="success">{t('run.running')}</Tag>}
                  </span>
                )}
                renderMeta={summary => t('profile.listMeta', { bundles: summary.bundles, plugins: summary.plugins, patch: summary.patchRows })}
                actions={summary => <ConfirmMenu actions={actionsFor(summary)} onAction={key => handleAction(summary, key)} />}
                loading={loading}
                empty={
                  <EmptyState
                    title={t('profile.empty.noProfiles')}
                    description={t('profile.empty.noProfilesDesc')}
                    action={<Button type="primary" disabled={dshId === undefined} onClick={() => setCreateOpen(true)}>{t('profile.newProfile')}</Button>}
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
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: LAYOUT.pagePaddingLG, background: token.colorBgContainer }}>
        {/* Detail only — running a profile and its console now live on the Run
            page (`RunsSection`); this page is pure profile management. */}
        {selected !== null && dshId !== undefined
          ? <ProfileDetailView dshId={dshId} name={selected} onRenamed={newName => { setSelected(newName); void refresh() }} onChanged={() => void refresh()} />
          : <EmptyState title={t('profile.selectProfile')} description={t('profile.selectProfileDesc')} />}
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
      dshId={dshId ?? ''}
      json={importJson}
      defaultName={importDefaultName}
      unpackDir={importUnpack}
      importDshVersion={importDshVersion}
      activeDshVersion={dshes.find(d => d.id === dshId)?.version ?? ''}
      onClose={() => setImportOpen(false)}
      onImported={onImported}
    />
    <MirrorProfileModal
      open={mirrorTarget !== null}
      sourceDshId={dshId ?? ''}
      profileName={mirrorTarget ?? ''}
      onClose={() => setMirrorTarget(null)}
      onMirrored={async () => { await refresh(); await trash.load() }}
    />
    </>
  )
}
