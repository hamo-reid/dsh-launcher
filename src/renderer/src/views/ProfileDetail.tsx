import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Badge, Button, Input, Modal, Select, Space, theme, message,
} from 'antd'
import {
  ApartmentOutlined, ApiOutlined, AppstoreOutlined, CheckCircleFilled, CodeOutlined, FileTextOutlined,
  FolderOpenOutlined, HomeOutlined, PlusOutlined, ProfileOutlined, ReloadOutlined,
  SafetyCertificateOutlined, SwapOutlined, UpOutlined,
} from '@ant-design/icons'
import type { DragEndEvent } from '@dnd-kit/core'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import { issueCount, lastSeenByRow, layerLabel, type LayerLabel } from '../lib/profileLayers.ts'
import { RenameProfileModal, TransferPatchModal } from './profile-detail/ProfileDialogs.tsx'
import LayerRows from './profile-detail/LayerRows.tsx'
import RawEditor from './profile-detail/RawEditor.tsx'
import DepsSection from './profile-detail/DepsSection.tsx'
import BundlesSection from './profile-detail/BundlesSection.tsx'
import PatchSection from './profile-detail/PatchSection.tsx'
import DiagnosticsSection from './profile-detail/DiagnosticsSection.tsx'
import ProfileInspector from './profile-detail/ProfileInspector.tsx'
import type { SectionKey } from './profile-detail/sections.ts'
import { NewRowModal, PatchRowEditorModal, SourceEditModal, type EditorTarget, type RowEditKind } from './profile-detail/PatchModals.tsx'
import type { InsertConflict, ProfileDetail, ProfileLayer, ProfileValidation } from '../../../shared/types.ts'
import FieldLabel from '../components/FieldLabel.tsx'
import Loadable from '../components/Loadable.tsx'
import NavList from '../components/NavList.tsx'
import Panel from '../components/Panel.tsx'
import ScrollModal from '../components/ScrollModal.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import { BundleVersionModal, PluginUpdatesModal, type BundleVersionTarget } from './PluginsModals.tsx'
import McpManagePanel from './McpManagePanel.tsx'
import { MODAL } from '../theme.ts'

interface Props {
  /** The dsh this profile belongs to (no global active dsh). */
  dshId: string
  name: string
  /** Called after this view mutates profile config, so the owner can refresh
   * aggregate state (e.g. the "missing bundles" hint). */
  onChanged?: () => void
  /** Called after a successful directory rename, with the new profile name. */
  onRenamed?: (newName: string) => void
}

export default function ProfileDetailView({ dshId, name, onChanged, onRenamed }: Props) {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  // Self-managed data: the panel stays mounted across selection changes; only
  // this state updates (stale-guarded), so fast switching never remounts.
  const [detail, setDetail] = useState<ProfileDetail | null>(null)
  const [layers, setLayers] = useState<ProfileLayer[] | null>(null)
  const [conflicts, setConflicts] = useState<InsertConflict[]>([])
  // Every row the profile resolves (bundle → profile → home), disabled and
  // bundle-provided ones included — the same set the MCP section lists, so the
  // navigation count can never disagree with the panel. `null` = not loaded yet.
  const [mcpCount, setMcpCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  const [openLayer, setOpenLayer] = useState<number | null>(null)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [reconciling, setReconciling] = useState(false)

  // Source mode: raw `cordis.patch.yml` editing in Monaco (content lives in the dialog).
  const [sourceOpen, setSourceOpen] = useState(false)

  // Workspace: active section + raw manifest/home editors + validation report.
  const [section, setSection] = useState<SectionKey>('patch')
  const [manifestText, setManifestText] = useState('')
  const [homeText, setHomeText] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const [fileSaving, setFileSaving] = useState(false)
  const [validation, setValidation] = useState<ProfileValidation | null>(null)
  const [validating, setValidating] = useState(false)

  // Dependency editing. (The drafts live in the section; only the in-flight flag and
  // the manifest metadata are shared, since `load` re-seeds the latter.)
  const [depBusy, setDepBusy] = useState(false)
  const [metaName, setMetaName] = useState('')
  const [metaReload, setMetaReload] = useState<'live' | 'startup'>('live')
  const [metaBusy, setMetaBusy] = useState(false)
  // Collapse state for the (potentially very long) conflict list.
  const [conflictsOpen, setConflictsOpen] = useState(false)

  // Bundle activation: installed-but-inactive bundles offered for activation.
  // (The pick lives in the section.)
  const [candidates, setCandidates] = useState<string[]>([])

  // Replace one bundle layer's version (store/npm-backed layers only).
  const [bundleVersionTarget, setBundleVersionTarget] = useState<BundleVersionTarget | null>(null)

  // Rename. (The field's value lives in the dialog.)
  const [renameOpen, setRenameOpen] = useState(false)

  // Per-profile plugin updates.
  const [updatesOpen, setUpdatesOpen] = useState(false)

  // Cross-profile patch transfer. (The target list lives in the dialog.)
  const [transferOpen, setTransferOpen] = useState(false)

  // Workspace chrome.
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [depsAddOpen, setDepsAddOpen] = useState(false)
  const [bundleActivateOpen, setBundleActivateOpen] = useState(false)

  const [newRowOpen, setNewRowOpen] = useState(false)

  /** The translated text of a layer label. Labels travel as keys so the memo over
   * them never depends on this function. */
  const labelText = (label: LayerLabel): string => t(label.key, label.options)

  // A bumped sequence guards the last-write-wins: whenever `name` changes or a
// handler triggers a refresh, every in-flight load past the newer seq is
// discarded so a stale response can't overwrite fresher data (e.g. after a fast
// A→B profile switch).
const loadSeq = useRef(0)
  const load = async (): Promise<void> => {
    const seq = ++loadSeq.current
    if (name === '') { setDetail(null); setLayers(null); setConflicts([]); setLoading(false); return }
    setLoading(true)
    const [detailRes, layersRes, conflictsRes, candidatesRes, mcpRes] = await Promise.all([
      window.api.loadProfile(dshId, name),
      window.api.layers(dshId, name),
      window.api.conflicts(dshId, name),
      window.api.missingBundles(dshId, name),
      window.api.ext.mcpList(dshId, name),
    ])
    if (seq !== loadSeq.current) return // a newer load superseded this one
    if (detailRes.ok) {
      setDetail(detailRes.value)
      setMetaName(detailRes.value.displayName)
      setMetaReload(detailRes.value.patchReload)
    }
    if (layersRes.ok) setLayers(layersRes.value)
    if (conflictsRes.ok) setConflicts(conflictsRes.value)
    if (candidatesRes.ok) setCandidates(candidatesRes.value)
    // `mcpList` here only feeds the count — the panel fetches its own rows, and
    // reports back through `onCount` so the number follows edits made inside it.
    if (mcpRes.ok) setMcpCount(mcpRes.value.servers.length)
    setLoading(false)
  }

  useEffect(() => {
    setDetail(null)
    setLayers(null)
    setConflicts([])
    setMcpCount(null)
    setLoading(true)
    if (name === '') { setLoading(false); return undefined }
    void load()
  }, [name, dshId])

  // Memoized on `layers` alone: `lastSeenByRow` returns keys, not translated text.
  const lastSeen = useMemo(() => lastSeenByRow(layers ?? []), [layers])

  const toggleProfile = async (id: string, disabled: boolean): Promise<void> => {
    const result = await window.api.setDisabled(dshId, name, id, disabled)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    void load()
    onChanged?.()
  }
  const toggleHome = async (id: string, disabled: boolean): Promise<void> => {
    const result = await window.api.home.setDisabled(dshId, id, disabled)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    void load()
    onChanged?.()
  }

  const openEdit = (id: string, kind: RowEditKind): void => {
    setOpenLayer(null)
    const owner = lastSeen.get(id)
    // The row's own profile layer is not an "overlap"; any other layer serving it is.
    const ownerText = owner === undefined ? undefined : labelText(owner)
    const overlap = ownerText !== undefined && ownerText !== t('profile.layer.profile', { name }) ? ownerText : null
    setEditor({ id, kind, overlap })
  }

  const copyFromBundle = (bundle: string, id: string): void => {
    Modal.confirm({
      title: t('profile.detail.copyFromBundleTitle'),
      content: t('profile.detail.copyFromBundlePrompt', { id }),
      okText: t('profile.create.create'),
      onOk: async () => {
        const result = await window.api.copyRow(dshId, name, bundle, id)
        if (!result.ok) return void message.error(apiErrorText(result))
        void load()
        void message.success(t('profile.detail.coverCreated'))
        onChanged?.()
      },
    })
  }
  const removeCover = (id: string): void => {
    Modal.confirm({
      title: t('profile.detail.removeCoverTitle'),
      content: t('profile.detail.removeCoverPrompt', { id }),
      okText: t('profile.detail.remove'),
      okButtonProps: { danger: true },
      onOk: async () => {
        const result = await window.api.removeRow(dshId, name, id)
        if (!result.ok) return void message.error(apiErrorText(result))
        void load()
        void message.success(t('profile.detail.coverRemoved'))
        onChanged?.()
      },
    })
  }

  const reconcileNow = async (): Promise<void> => {
    setReconciling(true)
    const result = await window.api.reconcileBundles(dshId, name)
    setReconciling(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    const { added, removed } = result.value
    if (added.length === 0 && removed.length === 0) void message.info(t('profile.detail.reconcileNoChange'))
    else void message.success(t('profile.detail.reconcileDone', { added: added.join(t('common.listSep')) || '—', removed: removed.join(t('common.listSep')) || '—' }))
    void load()
    onChanged?.()
  }

  // Open this profile's cordis.patch.yml in the OS default editor (for hand-editing / repair).
  const openPatchSource = async (): Promise<void> => {
    const result = await window.api.openPatchSource(dshId, name)
    if (!result.ok) void message.error(apiErrorText(result))
  }

  // Source mode: edit the same patch file in place, validated on save. The dialog
  // loads the file when it opens.
  const openSource = (): void => setSourceOpen(true)

  // ── workspace: lazy-load the raw editors when their section is shown ─────
  useEffect(() => {
    if (section !== 'manifest') return undefined
    let alive = true
    setFileLoading(true)
    void window.api.readFile(dshId, name, 'manifest').then(result => {
      if (!alive) return
      setFileLoading(false)
      if (result.ok) setManifestText(result.value.text)
      else void message.error(apiErrorText(result))
    })
    return () => { alive = false }
  }, [section, dshId, name])

  useEffect(() => {
    if (section !== 'home') return undefined
    let alive = true
    setFileLoading(true)
    void window.api.home.readPatch(dshId).then(result => {
      if (!alive) return
      setFileLoading(false)
      if (result.ok) setHomeText(result.value.text)
      else void message.error(apiErrorText(result))
    })
    return () => { alive = false }
  }, [section, dshId])

  // Re-run the composition check after any structural edit (the layer list
  // changes) and on mount, so the inspector is always current.
  useEffect(() => {
    let alive = true
    setValidating(true)
    void window.api.validate(dshId, name).then(result => {
      if (!alive) return
      setValidating(false)
      setValidation(result.ok ? result.value : null)
    })
    return () => { alive = false }
  }, [dshId, name, layers])

  const saveManifest = async (): Promise<void> => {
    setFileSaving(true)
    const result = await window.api.writeFile(dshId, name, 'manifest', manifestText)
    setFileSaving(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    void message.success(t('profile.detail.fileSaved'))
    void load()
    onChanged?.()
  }

  const saveHome = async (): Promise<void> => {
    setFileSaving(true)
    const result = await window.api.home.writePatch(dshId, homeText)
    setFileSaving(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    void message.success(t('profile.detail.fileSaved'))
    void load()
    onChanged?.()
  }

  const revalidate = (): void => {
    setValidating(true)
    void window.api.validate(dshId, name).then(result => {
      setValidating(false)
      setValidation(result.ok ? result.value : null)
    })
  }

  const dependencySpecs = detail?.dependencySpecs ?? {}

  const saveDependency = async (pkg: string, spec: string): Promise<boolean> => {
    if (spec === '') { void message.warning(t('profile.workspace.depSpecRequired')); return false }
    setDepBusy(true)
    const result = await window.api.setDependency(dshId, name, pkg, spec)
    setDepBusy(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return false }
    void message.success(t('profile.workspace.depSaved', { pkg }))
    void load()
    onChanged?.()
    return true
  }

  const removeDep = (pkg: string): void => {
    Modal.confirm({
      title: t('profile.workspace.depRemove'),
      content: t('profile.workspace.depRemoveConfirm', { pkg }),
      okText: t('profile.detail.remove'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setDepBusy(true)
        const result = await window.api.removeDependency(dshId, name, pkg)
        setDepBusy(false)
        if (!result.ok) return void message.error(apiErrorText(result))
        void load()
        onChanged?.()
      },
    })
  }

  const addDep = async (pkg: string, spec: string): Promise<boolean> => {
    if (pkg === '' || spec === '') { void message.warning(t('profile.workspace.depBothRequired')); return false }
    setDepBusy(true)
    const result = await window.api.setDependency(dshId, name, pkg, spec)
    setDepBusy(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return false }
    void load()
    onChanged?.()
    return true
  }

  const saveMeta = async (): Promise<void> => {
    setMetaBusy(true)
    const result = await window.api.setManifest(dshId, name, { displayName: metaName, patchReload: metaReload })
    setMetaBusy(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    void message.success(t('profile.detail.fileSaved'))
    void load()
    onChanged?.()
  }

  const activateBundle = async (pkg: string): Promise<boolean> => {
    setDepBusy(true)
    const result = await window.api.addBundle(dshId, name, pkg)
    setDepBusy(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return false }
    void message.success(t('profile.workspace.bundleActivated', { pkg }))
    void load()
    onChanged?.()
    return true
  }

  const revealProfile = async (): Promise<void> => {
    const result = await window.api.reveal(dshId, name)
    if (!result.ok) void message.error(apiErrorText(result))
  }

  const removeBundleRow = (bundle: string): void => {
    Modal.confirm({
      title: t('profile.detail.removeBundle'),
      content: t('profile.detail.removeBundleConfirm', { profile: name, bundle }),
      okText: t('profile.detail.remove'),
      okButtonProps: { danger: true },
      onOk: async () => {
        const result = await window.api.removeBundle(dshId, name, bundle)
        if (!result.ok) return void message.error(apiErrorText(result))
        void load()
        onChanged?.()
        void message.success(t('profile.detail.bundleRemoved', { bundle }))
      },
    })
  }

  // Open the version picker for one bundle layer. Only store/npm-backed layers
  // reach here (in-box and local layers are read-only in the row).
  const replaceBundleVersion = (bundle: string): void => {
    const current = detail?.bundleInfo?.[bundle]?.version
    setBundleVersionTarget({
      dshId, profile: name, bundle,
      ...(current !== undefined && current !== '' ? { current } : {}),
    })
  }

  // Rebuild a local/dev `link:` dependency (pnpm can leave a stale junction and
  // then treat `install` as a no-op — see TROUBLESHOOTING §1).
  const relinkBundle = async (bundle: string): Promise<void> => {
    setDepBusy(true)
    const r = await window.api.plugins.devRepairLink(dshId, name, bundle)
    setDepBusy(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(r.value)
    void load()
    onChanged?.()
  }

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (over === null || active.id === over.id) return
    const from = bundles.indexOf(String(active.id))
    const to = bundles.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    const next = [...bundles]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    // Optimistic: apply the new order locally first (no full reload, so the dialog
    // doesn't flicker on drop), then persist silently; only on failure reload to
    // restore the authoritative order. `onChanged` is skipped — the bundle count in
    // the profile summary is unchanged by a reorder.
    setDetail(prev => (prev !== null ? { ...prev, bundles: next } : prev))
    void (async () => {
      const result = await window.api.reorderBundles(dshId, name, String(active.id), to)
      if (result.ok) return
      void message.error(apiErrorText(result))
      void load()
    })()
  }


  const activeLayer = openLayer !== null && layers !== null ? layers[openLayer] : undefined
  const bundles = detail?.bundles ?? []
  const dependencies = detail?.dependencies ?? []
  const profileLayer = (layers ?? []).find(layer => layer.source === 'profile')

  if (name === '') return null

  const issues = issueCount(conflicts, validation)

  const navItems: { key: SectionKey; icon: ReactNode; label: string; meta: ReactNode }[] = [
    { key: 'manifest', icon: <ProfileOutlined />, label: t('profile.workspace.manifest'), meta: null },
    { key: 'deps', icon: <ApartmentOutlined />, label: t('profile.workspace.deps'), meta: dependencies.length || null },
    { key: 'bundles', icon: <AppstoreOutlined />, label: t('profile.workspace.bundles'), meta: bundles.length || null },
    { key: 'mcp', icon: <ApiOutlined />, label: t('profile.workspace.mcp'), meta: mcpCount === null || mcpCount === 0 ? null : mcpCount },
    { key: 'patch', icon: <CodeOutlined />, label: t('profile.workspace.patch'), meta: (profileLayer?.rows.length ?? 0) || null },
    { key: 'home', icon: <HomeOutlined />, label: t('profile.workspace.home'), meta: null },
    {
      key: 'diagnostics',
      icon: <SafetyCertificateOutlined />,
      label: t('profile.workspace.diagnostics'),
      meta: validation === null
        ? null
        : validation.ok
          ? <CheckCircleFilled style={{ color: token.colorSuccess }} />
          : <Badge count={issues} size="small" />,
    },
  ]

  // Section-local actions live in the panel header; the page header keeps only
  // the global ones (validate / rename / reveal / inspector).
  const sectionActions = (): ReactNode => {
    if (section === 'deps') {
      return (
        <Space size={8}>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => setUpdatesOpen(true)}>{t('plugin.update.check')}</Button>
          {/* A toggle, not the action itself: the label flips to "collapse" so it
              cannot be mistaken for the form's own submit button below. */}
          <Button
            size="small"
            icon={depsAddOpen ? <UpOutlined /> : <PlusOutlined />}
            onClick={() => setDepsAddOpen(v => !v)}
          >
            {depsAddOpen ? t('common.collapse') : t('profile.workspace.depAdd')}
          </Button>
        </Space>
      )
    }
    if (section === 'bundles') {
      return (
        <Space size={8}>
          <Button size="small" icon={<ReloadOutlined />} loading={reconciling} onClick={() => void reconcileNow()}>{t('profile.detail.reconcile')}</Button>
          {/* Same toggle/submit split as the dependency form above. */}
          {candidates.length > 0 && (
            <Button
              size="small"
              type="primary"
              icon={bundleActivateOpen ? <UpOutlined /> : <PlusOutlined />}
              onClick={() => setBundleActivateOpen(v => !v)}
            >
              {bundleActivateOpen ? t('common.collapse') : t('profile.workspace.bundleActivate')}
            </Button>
          )}
        </Space>
      )
    }
    if (section === 'patch') {
      return (
        <Space size={8}>
          <Button size="small" icon={<CodeOutlined />} onClick={openSource}>{t('profile.detail.sourceEdit')}</Button>
          <Button size="small" icon={<FileTextOutlined />} onClick={() => void openPatchSource()}>{t('profile.detail.openPatchSource')}</Button>
          <Button size="small" icon={<SwapOutlined />} onClick={() => setTransferOpen(true)}>{t('profile.workspace.transfer')}</Button>
        </Space>
      )
    }
    // Diagnostics adds no action of its own: "validate" is a page-level action,
    // shown in the header from every section, so a second copy here was the same
    // button twice on one screen.
    return null
  }



  return (
    <Loadable loading={loading}>
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: token.paddingSM }}>
      <SectionHeading title={(
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {name}
          {conflicts.length > 0 && <Badge count={conflicts.length} />}
        </span>
      )} extra={(
        <Space size={8}>
          <Button size="small" onClick={revalidate} loading={validating}>{t('profile.workspace.validate')}</Button>
          <Button size="small" onClick={() => setRenameOpen(true)}>{t('profile.workspace.rename')}</Button>
          <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void revealProfile()}>{t('profile.workspace.reveal')}</Button>
          <Button size="small" type={inspectorOpen ? 'primary' : 'default'} onClick={() => setInspectorOpen(v => !v)}>{t('profile.workspace.inspector')}</Button>
        </Space>
      )} />

      <div style={{ display: 'flex', gap: token.paddingSM, flex: 1, minHeight: 0 }}>
        <div style={{ width: 208, flexShrink: 0, minHeight: 0, overflowY: 'auto' }}>
          <NavList
            items={navItems}
            keyOf={item => item.key}
            selectedKey={section}
            onSelect={item => setSection(item.key)}
            renderTitle={item => (
              // ONE row per section: icon + label on the left, the count (or the
              // validity mark) pushed to the right edge. The count used to be a
              // subtitle line, which made rows that had one taller than rows that
              // did not — the rail never lined up.
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  {item.icon}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                </span>
                {item.meta !== null && (
                  <span style={{
                    flex: '0 0 auto', marginInlineStart: 'auto',
                    color: token.colorTextTertiary, fontSize: token.fontSizeSM, fontWeight: 400,
                  }}>
                    {item.meta}
                  </span>
                )}
              </span>
            )}
          />
        </div>

        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
          <Panel
            fill
            pad={false}
            title={section === 'mcp' && mcpCount !== null
              ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  {t('profile.workspace.mcp')}
                  <span style={{ color: token.colorTextTertiary, fontWeight: 400, fontSize: token.fontSizeSM }}>
                    {t('profile.workspace.mcpCount', { count: mcpCount })}
                  </span>
                </span>
              )
              : t(`profile.workspace.${section}`)}
            extra={sectionActions()}
          >
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: token.padding }}>
      {section === 'manifest' && (
        <RawEditor
          hint={t('profile.workspace.manifestHint')}
          value={manifestText}
          onChange={setManifestText}
          language="json"
          loading={fileLoading}
          saving={fileSaving}
          onSave={() => void saveManifest()}
          header={(
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: '0 0 320px' }}>
                <FieldLabel>{t('profile.workspace.displayName')}</FieldLabel>
                <Input value={metaName} onChange={e => setMetaName(e.target.value)} />
              </div>
              <div style={{ flex: '0 0 200px' }}>
                <FieldLabel>{t('profile.workspace.patchReload')}</FieldLabel>
                <Select value={metaReload} onChange={v => setMetaReload(v)} style={{ width: '100%' }} options={[{ value: 'live', label: 'live' }, { value: 'startup', label: 'startup' }]} />
              </div>
              <Button type="primary" loading={metaBusy} onClick={() => void saveMeta()}>{t('common.save')}</Button>
            </div>
          )}
        />
      )}

      {section === 'deps' && (
        <DepsSection
          dependencies={dependencies}
          specs={dependencySpecs}
          busy={depBusy}
          addOpen={depsAddOpen}
          onSave={saveDependency}
          onRemove={removeDep}
          onAdd={addDep}
        />
      )}

      {section === 'bundles' && (
        <BundlesSection
          bundles={bundles}
          bundleInfo={detail?.bundleInfo}
          candidates={candidates}
          activateOpen={bundleActivateOpen}
          busy={depBusy}
          onReorder={onDragEnd}
          onRemove={removeBundleRow}
          onReplace={replaceBundleVersion}
          onRelink={b => void relinkBundle(b)}
          onActivate={activateBundle}
        />
      )}

      {section === 'mcp' && (
        <McpManagePanel dshId={dshId} profile={name} withPanel={false} onCount={setMcpCount} />
      )}

      {section === 'patch' && <PatchSection layers={layers} onOpenLayer={setOpenLayer} />}

      {section === 'home' && (
        <RawEditor
          hint={t('profile.workspace.homeHint')}
          value={homeText}
          onChange={setHomeText}
          language="yaml"
          loading={fileLoading}
          saving={fileSaving}
          onSave={() => void saveHome()}
        />
      )}

      {section === 'diagnostics' && (
        <DiagnosticsSection
          validation={validation}
          validating={validating}
          conflictsOpen={conflictsOpen}
          onToggleConflicts={() => setConflictsOpen(open => !open)}
        />
      )}
            </div>
          </Panel>
        </div>

        {inspectorOpen && (
          <ProfileInspector
            validation={validation}
            validating={validating}
            bundleCount={bundles.length}
            patchRowCount={profileLayer?.rows.length ?? 0}
            depCount={dependencies.length}
            onValidate={revalidate}
            onReveal={() => void revealProfile()}
            onJump={(target, expandConflicts) => { setSection(target); if (expandConflicts === true) setConflictsOpen(true) }}
          />
        )}
      </div>

      <ScrollModal title={activeLayer !== undefined ? labelText(layerLabel(activeLayer)) : ''} open={openLayer !== null} footer={null} onCancel={() => setOpenLayer(null)} width={MODAL.wide} bodyMax={440}>
        {activeLayer?.source === 'profile' && (
          <Button type="dashed" block style={{ marginBottom: token.paddingSM }} onClick={() => setNewRowOpen(true)}>{t('profile.detail.newRow')}</Button>
        )}
        {activeLayer !== undefined && (
          <LayerRows
            layer={activeLayer}
            lastSeen={lastSeen}
            onToggle={(id, disabled) => void (activeLayer.source === 'home' ? toggleHome(id, disabled) : toggleProfile(id, disabled))}
            onCover={(id) => { if (activeLayer.bundle !== undefined) copyFromBundle(activeLayer.bundle, id) }}
            onEdit={openEdit}
            onRemoveCover={removeCover}
          />
        )}
      </ScrollModal>

      <PatchRowEditorModal
        dshId={dshId}
        name={name}
        target={editor}
        onClose={() => setEditor(null)}
        onSaved={() => { void load(); onChanged?.() }}
      />

      <NewRowModal
        dshId={dshId}
        name={name}
        open={newRowOpen}
        onClose={() => setNewRowOpen(false)}
        onSaved={() => { void load(); onChanged?.() }}
      />

      <SourceEditModal
        dshId={dshId}
        name={name}
        open={sourceOpen}
        onClose={() => setSourceOpen(false)}
        onSaved={() => { void load(); onChanged?.() }}
      />

      <RenameProfileModal
        dshId={dshId}
        name={name}
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        onRenamed={next => onRenamed?.(next)}
      />

      <TransferPatchModal
        dshId={dshId}
        name={name}
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        onMoved={() => { void load(); onChanged?.() }}
      />

      <BundleVersionModal
        target={bundleVersionTarget}
        onClose={() => setBundleVersionTarget(null)}
        onDone={() => { void load(); onChanged?.() }}
      />

      <PluginUpdatesModal
        open={updatesOpen}
        dshId={dshId}
        profile={name}
        onClose={() => setUpdatesOpen(false)}
        onDone={() => { void load(); onChanged?.() }}
      />
    </div>
    </Loadable>
  )
}

