import { cloneElement, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Alert, Badge, Button, Input, Modal, Select, Space, Tag, Tooltip, theme, message,
} from 'antd'
import {
  ApartmentOutlined, ApiOutlined, AppstoreOutlined, CheckCircleFilled, CodeOutlined, FileTextOutlined,
  FolderOpenOutlined, HomeOutlined, PlusOutlined, ProfileOutlined, ReloadOutlined,
  SafetyCertificateOutlined, SwapOutlined,
} from '@ant-design/icons'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import type { InsertConflict, InsertConflictLayer, ProfileBundleInfo, ProfileDetail, ProfileLayer, ProfileValidation, RowCreateInput } from '../../../shared/types.ts'
import ActionCard from '../components/ActionCard.tsx'
import FieldLabel from '../components/FieldLabel.tsx'
import Loadable from '../components/Loadable.tsx'
import NavList from '../components/NavList.tsx'
import Panel from '../components/Panel.tsx'
import ScrollModal from '../components/ScrollModal.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import StatusTag from '../components/StatusTag.tsx'
import { BundleVersionModal, PluginUpdatesModal, type BundleVersionTarget } from './PluginsModals.tsx'
import McpManagePanel from './McpManagePanel.tsx'
import { MODAL } from '../theme.ts'

// The Monaco wrapper pulls the whole editor; keep it out of the first parse.
const CodeEditor = lazy(() => import('../components/CodeEditor.tsx'))

/** Tag colour per bundle version source (matches the plugin overview's palette). */
const BUNDLE_SOURCE_COLORS: Record<ProfileBundleInfo['source'], string> = {
  dsh: 'purple',
  store: 'blue',
  npm: 'geekblue',
  local: 'default',
}

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

type EditKind = 'config' | 'insert'

/** The workspace's left-hand sections. */
type SectionKey = 'manifest' | 'deps' | 'bundles' | 'mcp' | 'patch' | 'home' | 'diagnostics'

interface Editor {
  id: string
  kind: EditKind
  overlap: string | null
}

export default function ProfileDetailView({ dshId, name, onChanged, onRenamed }: Props) {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  // Self-managed data: the panel stays mounted across selection changes; only
  // this state updates (stale-guarded), so fast switching never remounts.
  const [detail, setDetail] = useState<ProfileDetail | null>(null)
  const [layers, setLayers] = useState<ProfileLayer[] | null>(null)
  const [conflicts, setConflicts] = useState<InsertConflict[]>([])
  const [loading, setLoading] = useState(true)

  const [openLayer, setOpenLayer] = useState<number | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [editText, setEditText] = useState('')
  const [cfgDefault, setCfgDefault] = useState('')
  const [saving, setSaving] = useState(false)
  const [reconciling, setReconciling] = useState(false)

  // Source mode: raw `cordis.patch.yml` editing in Monaco.
  const [sourceOpen, setSourceOpen] = useState(false)
  const [sourceText, setSourceText] = useState('')
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceSaving, setSourceSaving] = useState(false)

  // Workspace: active section + raw manifest/home editors + validation report.
  const [section, setSection] = useState<SectionKey>('patch')
  const [manifestText, setManifestText] = useState('')
  const [homeText, setHomeText] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const [fileSaving, setFileSaving] = useState(false)
  const [validation, setValidation] = useState<ProfileValidation | null>(null)
  const [validating, setValidating] = useState(false)

  // Dependency editing + manifest metadata.
  const [depEdits, setDepEdits] = useState<Record<string, string>>({})
  const [depEditing, setDepEditing] = useState<string | null>(null)
  const [newDepPkg, setNewDepPkg] = useState('')
  const [newDepSpec, setNewDepSpec] = useState('')
  const [depBusy, setDepBusy] = useState(false)
  const [metaName, setMetaName] = useState('')
  const [metaReload, setMetaReload] = useState<'live' | 'startup'>('live')
  const [metaBusy, setMetaBusy] = useState(false)
  // Collapse state for the (potentially very long) conflict list.
  const [conflictsOpen, setConflictsOpen] = useState(false)

  // Bundle activation: installed-but-inactive bundles offered for activation.
  const [candidates, setCandidates] = useState<string[]>([])
  const [addBundlePkg, setAddBundlePkg] = useState<string>()

  // Replace one bundle layer's version (store/npm-backed layers only).
  const [bundleVersionTarget, setBundleVersionTarget] = useState<BundleVersionTarget | null>(null)

  // Rename.
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renaming, setRenaming] = useState(false)

  // Per-profile plugin updates.
  const [updatesOpen, setUpdatesOpen] = useState(false)

  // Cross-profile patch transfer.
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferTargets, setTransferTargets] = useState<string[]>([])
  const [transferTarget, setTransferTarget] = useState<string>()
  const [transferBusy, setTransferBusy] = useState(false)

  // Workspace chrome.
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [depsAddOpen, setDepsAddOpen] = useState(false)
  const [bundleActivateOpen, setBundleActivateOpen] = useState(false)

  const [newRowOpen, setNewRowOpen] = useState(false)
  const [newRowId, setNewRowId] = useState('')
  const [newRowDisabled, setNewRowDisabled] = useState(false)
  const [newRowConfig, setNewRowConfig] = useState('')
  const [newRowInsert, setNewRowInsert] = useState('')

  const layerLabel = (layer: ProfileLayer): string => {
    if (layer.source === 'bundle') return t('profile.layer.bundle', { name: layer.bundle ?? '' })
    if (layer.source === 'profile') return t('profile.layer.profile', { name: layer.label ?? '' })
    return t('profile.layer.home')
  }

  const conflictLayerLabel = (layer: InsertConflictLayer): string => {
    if (layer.source === 'bundle') return t('profile.layer.bundle', { name: layer.bundle ?? '' })
    if (layer.source === 'profile') return t('profile.layer.profile', { name: layer.label ?? '' })
    if (layer.source === 'home') return t('profile.layer.home')
    return t('profile.detail.patchLayer', { name: layer.label ?? '' })
  }

  // A bumped sequence guards the last-write-wins: whenever `name` changes or a
// handler triggers a refresh, every in-flight load past the newer seq is
// discarded so a stale response can't overwrite fresher data (e.g. after a fast
// A→B profile switch).
const loadSeq = useRef(0)
  const load = async (): Promise<void> => {
    const seq = ++loadSeq.current
    if (name === '') { setDetail(null); setLayers(null); setConflicts([]); setLoading(false); return }
    setLoading(true)
    const [detailRes, layersRes, conflictsRes, candidatesRes] = await Promise.all([
      window.api.loadProfile(dshId, name),
      window.api.layers(dshId, name),
      window.api.conflicts(dshId, name),
      window.api.missingBundles(dshId, name),
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
    setLoading(false)
  }

  useEffect(() => {
    setDetail(null)
    setLayers(null)
    setConflicts([])
    setLoading(true)
    if (name === '') { setLoading(false); return undefined }
    void load()
  }, [name, dshId])

  const lastSeen = useMemo(() => {
    const map = new Map<string, string>()
    if (layers === null) return map
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const label = layerLabel(layers[i])
      for (const row of layers[i].rows) if (!map.has(row.id)) map.set(row.id, label)
    }
    return map
  }, [layers, layerLabel])

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

  const openEdit = (id: string, kind: EditKind): void => {
    setOpenLayer(null)
    const owner = lastSeen.get(id)
    const overlap = owner !== undefined && owner !== t('profile.layer.profile', { name }) ? owner : null
    setEditText('')
    setCfgDefault('')
    setEditor({ id, kind, overlap })
    if (kind === 'config') {
      void window.api.configInfo(dshId, name, id).then(result => {
        if (result.ok) {
          setCfgDefault(result.value.default)
          setEditText(result.value.current)
        }
      })
    }
  }

  const submit = async (): Promise<void> => {
    if (editor === null) return
    setSaving(true)
    let result
    if (editor.kind === 'config') {
      if (editText.trim() === '') { void message.warning(t('profile.detail.configEmpty')); setSaving(false); return }
      result = await window.api.setRowConfig(dshId, name, editor.id, editText)
    } else {
      const items = editText.split('\n').map(line => line.trim()).filter(Boolean)
      if (items.length === 0) { void message.warning(t('profile.detail.insertEmpty')); setSaving(false); return }
      result = await window.api.addRow(dshId, name, { id: editor.id, insert: items })
    }
    setSaving(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    setEditor(null)
    void load()
    void message.success(editor.kind === 'config' ? t('profile.detail.savedConfig') : t('profile.detail.savedInsert'))
    onChanged?.()
  }

  const submitNew = async (): Promise<void> => {
    const id = newRowId.trim()
    if (id === '') { void message.warning(t('profile.detail.rowIdEmpty')); return }
    const row: RowCreateInput = { id, disabled: newRowDisabled }
    const cfg = newRowConfig.trim()
    const ins = newRowInsert.split('\n').map(line => line.trim()).filter(Boolean)
    if (cfg !== '') row.config = cfg
    else if (ins.length > 0) row.insert = ins
    const result = await window.api.addRow(dshId, name, row)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    setNewRowOpen(false)
    setNewRowId('')
    setNewRowDisabled(false)
    setNewRowConfig('')
    setNewRowInsert('')
    void load()
    void message.success(t('profile.created'))
    onChanged?.()
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
    else void message.success(t('profile.detail.reconcileDone', { added: added.join('、') || '—', removed: removed.join('、') || '—' }))
    void load()
    onChanged?.()
  }

  // Open this profile's cordis.patch.yml in the OS default editor (for hand-editing / repair).
  const openPatchSource = async (): Promise<void> => {
    const result = await window.api.openPatchSource(dshId, name)
    if (!result.ok) void message.error(apiErrorText(result))
  }

  // Source mode: edit the same patch file in place, validated on save.
  const openSource = async (): Promise<void> => {
    setSourceOpen(true)
    setSourceLoading(true)
    const result = await window.api.readFile(dshId, name, 'patch')
    setSourceLoading(false)
    if (!result.ok) { void message.error(apiErrorText(result)); setSourceOpen(false); return }
    setSourceText(result.value.text)
  }

  const saveSource = async (): Promise<void> => {
    setSourceSaving(true)
    const result = await window.api.writeFile(dshId, name, 'patch', sourceText)
    setSourceSaving(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    setSourceOpen(false)
    void message.success(t('profile.detail.sourceSaved'))
    void load()
    onChanged?.()
  }

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

  const saveDependency = async (pkg: string): Promise<void> => {
    const spec = (depEdits[pkg] ?? dependencySpecs[pkg] ?? '').trim()
    if (spec === '') { void message.warning(t('profile.workspace.depSpecRequired')); return }
    setDepBusy(true)
    const result = await window.api.setDependency(dshId, name, pkg, spec)
    setDepBusy(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    void message.success(t('profile.workspace.depSaved', { pkg }))
    setDepEdits(prev => { const next = { ...prev }; delete next[pkg]; return next })
    setDepEditing(null)
    void load()
    onChanged?.()
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

  const addDep = async (): Promise<void> => {
    const pkg = newDepPkg.trim()
    const spec = newDepSpec.trim()
    if (pkg === '' || spec === '') { void message.warning(t('profile.workspace.depBothRequired')); return }
    setDepBusy(true)
    const result = await window.api.setDependency(dshId, name, pkg, spec)
    setDepBusy(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    setNewDepPkg('')
    setNewDepSpec('')
    void load()
    onChanged?.()
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

  const activateBundle = async (): Promise<void> => {
    if (addBundlePkg === undefined) return
    setDepBusy(true)
    const result = await window.api.addBundle(dshId, name, addBundlePkg)
    setDepBusy(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    void message.success(t('profile.workspace.bundleActivated', { pkg: addBundlePkg }))
    setAddBundlePkg(undefined)
    void load()
    onChanged?.()
  }

  const doRename = async (): Promise<void> => {
    const target = renameValue.trim()
    if (target === '' || target === name) { setRenameOpen(false); return }
    setRenaming(true)
    const result = await window.api.rename(dshId, name, target)
    setRenaming(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    setRenameOpen(false)
    void message.success(t('profile.workspace.renamed', { name: target }))
    onRenamed?.(target)
  }

  const openTransfer = async (): Promise<void> => {
    setTransferTarget(undefined)
    setTransferOpen(true)
    const result = await window.api.listProfiles(dshId)
    if (result.ok) setTransferTargets(result.value.filter(p => p !== name))
  }

  const doTransfer = async (move: boolean): Promise<void> => {
    if (transferTarget === undefined) return
    setTransferBusy(true)
    const result = await window.api.transferPatch(dshId, name, dshId, transferTarget, move)
    setTransferBusy(false)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    setTransferOpen(false)
    void message.success(move
      ? t('profile.workspace.patchMoved', { name: transferTarget })
      : t('profile.workspace.patchCopied', { name: transferTarget }))
    if (move) { void load(); onChanged?.() }
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

  const rowActions = (layer: ProfileLayer, id: string, disabled: boolean) => {
    if (layer.source === 'bundle') {
      return layer.bundle !== undefined
        ? <Button size="small" onClick={() => copyFromBundle(layer.bundle!, id)}>{t('profile.detail.row.cover')}</Button>
        : null
    }
    const toggle = layer.source === 'home' ? toggleHome : toggleProfile
    const editable = layer.source === 'profile'
    return (
      <Space size={4}>
        <Button size="small" onClick={() => void toggle(id, !disabled)}>{disabled ? t('profile.detail.row.enable') : t('profile.detail.row.disable')}</Button>
        {editable && (
          <>
            <Button size="small" onClick={() => openEdit(id, 'config')}>{t('profile.detail.row.config')}</Button>
            <Button size="small" onClick={() => openEdit(id, 'insert')}>{t('profile.detail.row.insert')}</Button>
            <Button size="small" danger type="text" onClick={() => removeCover(id)}>{t('profile.detail.row.delete')}</Button>
          </>
        )}
      </Space>
    )
  }

  const renderRows = (layer: ProfileLayer) => {
    if (layer.rows.length === 0) {
      return <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>{t('profile.detail.layerNoRows')}</div>
    }
    return (
      <div>
        {layer.rows.map(row => {
          const here = layerLabel(layer)
          const override = lastSeen.get(row.id) !== here ? lastSeen.get(row.id) : undefined
          return (
            <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${token.colorSplit}` }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
                {row.name ?? row.id}
              </span>
              <StatusTag tone={row.disabled ? 'disabled' : 'enabled'}>{row.disabled ? t('profile.detail.disabled') : t('profile.detail.enabled')}</StatusTag>
              {row.hasConfig && <Tag>config</Tag>}
              {row.hasInsert && <Tag>insert</Tag>}
              {override !== undefined && <Tag style={{ color: token.colorTextTertiary, borderColor: token.colorBorder }}>{t('profile.detail.overridden', { override })}</Tag>}
              {rowActions(layer, row.id, row.disabled)}
            </div>
          )
        })}
      </div>
    )
  }

  const blockButton = (label: string, meta: string, onClick: () => void) => (
    <ActionCard title={label} meta={meta} onClick={onClick} hoverable />
  )

  const activeLayer = openLayer !== null && layers !== null ? layers[openLayer] : undefined
  const bundles = detail?.bundles ?? []
  const dependencies = detail?.dependencies ?? []
  const profileLayer = (layers ?? []).find(layer => layer.source === 'profile')

  if (name === '') return null

  const issueCount = conflicts.length
    + (validation?.manifestError !== undefined ? 1 : 0)
    + (validation?.patchError !== undefined ? 1 : 0)
    + (validation?.missingBundles.length ?? 0)
    + (validation?.unclaimedBundles.length ?? 0)

  const navItems: { key: SectionKey; icon: ReactNode; label: string; meta: ReactNode }[] = [
    { key: 'manifest', icon: <ProfileOutlined />, label: t('profile.workspace.manifest'), meta: null },
    { key: 'deps', icon: <ApartmentOutlined />, label: t('profile.workspace.deps'), meta: dependencies.length || null },
    { key: 'bundles', icon: <AppstoreOutlined />, label: t('profile.workspace.bundles'), meta: bundles.length || null },
    { key: 'mcp', icon: <ApiOutlined />, label: t('profile.workspace.mcp'), meta: null },
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
          : <Badge count={issueCount} size="small" />,
    },
  ]

  // Section-local actions live in the panel header; the page header keeps only
  // the global ones (validate / rename / reveal / inspector).
  const sectionActions = (): ReactNode => {
    if (section === 'deps') {
      return (
        <Space size={8}>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => setUpdatesOpen(true)}>{t('plugin.update.check')}</Button>
          <Button size="small" icon={<PlusOutlined />} onClick={() => setDepsAddOpen(v => !v)}>{t('profile.workspace.depAdd')}</Button>
        </Space>
      )
    }
    if (section === 'bundles') {
      return (
        <Space size={8}>
          <Button size="small" icon={<ReloadOutlined />} loading={reconciling} onClick={() => void reconcileNow()}>{t('profile.detail.reconcile')}</Button>
          {candidates.length > 0 && (
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setBundleActivateOpen(v => !v)}>{t('profile.workspace.bundleActivate')}</Button>
          )}
        </Space>
      )
    }
    if (section === 'patch') {
      return (
        <Space size={8}>
          <Button size="small" icon={<CodeOutlined />} onClick={() => void openSource()}>{t('profile.detail.sourceEdit')}</Button>
          <Button size="small" icon={<FileTextOutlined />} onClick={() => void openPatchSource()}>{t('profile.detail.openPatchSource')}</Button>
          <Button size="small" icon={<SwapOutlined />} onClick={() => void openTransfer()}>{t('profile.workspace.transfer')}</Button>
        </Space>
      )
    }
    if (section === 'diagnostics') {
      return <Button size="small" onClick={revalidate} loading={validating}>{t('profile.workspace.validate')}</Button>
    }
    return null
  }

  const issueRow = (label: string, count: number | undefined, onClick: () => void): ReactNode => (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick() } }}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        cursor: 'pointer', padding: '6px 8px', borderRadius: token.borderRadius, background: token.colorFillQuaternary,
      }}
    >
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {count !== undefined && <Badge count={count} size="small" />}
    </div>
  )

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
          <Button size="small" onClick={() => { setRenameValue(name); setRenameOpen(true) }}>{t('profile.workspace.rename')}</Button>
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
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{item.icon}{item.label}</span>
            )}
            renderMeta={item => item.meta}
          />
        </div>

        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
          <Panel fill pad={false} title={t(`profile.workspace.${section}`)} extra={sectionActions()}>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: token.padding }}>
      {section === 'manifest' && (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: token.paddingSM }}>
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
          <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>{t('profile.workspace.manifestHint')}</div>
          <div style={{ flex: 1, minHeight: 0 }}>
            {fileLoading
              ? <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextTertiary }}>{t('common.loading')}</div>
              : (
                <Suspense fallback={<div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextTertiary }}>{t('common.loading')}</div>}>
                  <CodeEditor value={manifestText} language="json" onChange={setManifestText} height="100%" />
                </Suspense>
              )}
          </div>
          <div>
            <Button type="primary" loading={fileSaving} onClick={() => void saveManifest()}>{t('common.save')}</Button>
          </div>
        </div>
      )}

      {section === 'deps' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: token.paddingSM }}>
          <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>{t('profile.workspace.depsHint')}</div>
          {dependencies.length === 0 && <div style={{ color: token.colorTextTertiary }}>{t('common.none')}</div>}
          {dependencies.map(dep => {
            const editing = depEditing === dep
            const draft = depEdits[dep] ?? dependencySpecs[dep] ?? ''
            return (
              <div key={dep} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: '0 0 34%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM }}>{dep}</span>
                {editing
                  ? (
                    <>
                      <Input size="small" value={draft} onChange={e => setDepEdits(prev => ({ ...prev, [dep]: e.target.value }))} style={{ flex: 1 }} onPressEnter={() => void saveDependency(dep)} />
                      <Button size="small" type="primary" disabled={depBusy} onClick={() => void saveDependency(dep)}>{t('common.save')}</Button>
                      <Button size="small" onClick={() => { setDepEditing(null); setDepEdits(prev => { const next = { ...prev }; delete next[dep]; return next }) }}>{t('common.cancel')}</Button>
                    </>
                  )
                  : (
                    <>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: token.colorTextSecondary, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM }}>{dependencySpecs[dep] ?? ''}</span>
                      <Button size="small" onClick={() => { setDepEdits(prev => ({ ...prev, [dep]: dependencySpecs[dep] ?? '' })); setDepEditing(dep) }}>{t('profile.workspace.depEdit')}</Button>
                      <Button size="small" danger type="text" disabled={depBusy} onClick={() => removeDep(dep)}>{t('profile.detail.remove')}</Button>
                    </>
                  )}
              </div>
            )
          })}
          {depsAddOpen && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: token.paddingSM }}>
              <Input size="small" value={newDepPkg} onChange={e => setNewDepPkg(e.target.value)} placeholder={t('profile.workspace.depPkg')} style={{ flex: '0 0 34%' }} />
              <Input size="small" value={newDepSpec} onChange={e => setNewDepSpec(e.target.value)} placeholder={t('profile.workspace.depSpec')} style={{ flex: 1 }} onPressEnter={() => void addDep()} />
              <Button size="small" type="primary" loading={depBusy} onClick={() => void addDep()}>{t('profile.workspace.depAdd')}</Button>
            </div>
          )}
        </div>
      )}

      {section === 'bundles' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: token.paddingSM }}>
          {bundles.length === 0
            ? <div style={{ color: token.colorTextTertiary }}>{t('common.none')}</div>
            : (
              <DndContext collisionDetection={closestCenter} autoScroll={false} onDragEnd={onDragEnd}>
                <SortableContext items={bundles} strategy={verticalListSortingStrategy}>
                  {bundles.map(bundle => (
                    <SortableBundle
                      key={bundle}
                      bundle={bundle}
                      info={detail?.bundleInfo?.[bundle]}
                      onRemove={removeBundleRow}
                      onReplace={replaceBundleVersion}
                      onRelink={b => void relinkBundle(b)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            )}
          {candidates.length > 0 && bundleActivateOpen && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: token.paddingSM }}>
              <Select
                size="small"
                value={addBundlePkg}
                onChange={setAddBundlePkg}
                placeholder={t('profile.workspace.bundleActivatePlaceholder')}
                style={{ flex: 1 }}
                options={candidates.map(pkg => ({ value: pkg, label: pkg }))}
              />
              <Button size="small" type="primary" disabled={addBundlePkg === undefined} loading={depBusy} onClick={() => void activateBundle()}>{t('profile.workspace.bundleActivate')}</Button>
            </div>
          )}
        </div>
      )}

      {section === 'mcp' && (
        <McpManagePanel dshId={dshId} profile={name} withPanel={false} />
      )}

      {section === 'patch' && (
        <>
          <div style={{ marginBottom: token.paddingSM, display: 'flex', gap: 8 }}>
            <Button size="small" icon={<CodeOutlined />} onClick={() => void openSource()}>{t('profile.detail.sourceEdit')}</Button>
            <Button size="small" onClick={() => void openTransfer()}>{t('profile.workspace.transfer')}</Button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: token.paddingSM }}>
            {(layers ?? []).map((layer, i) => cloneElement(
              blockButton(
                `${i + 1}. ${layerLabel(layer)}`,
                layer.source === 'profile' ? t('profile.detail.layerMetaEditable', { count: layer.rows.length }) : t('profile.detail.layerMeta', { count: layer.rows.length }),
                () => setOpenLayer(i),
              ),
              // Stable key derived from the layer's identity, so a bundle reorder
              // doesn't remount the cards (index would shuffle the keys).
              { key: layer.source === 'bundle' ? `bundle:${layer.bundle}` : layer.source === 'profile' ? `profile:${layer.label}` : 'home' },
            ))}
          </div>
        </>
      )}

      {section === 'home' && (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: token.paddingSM }}>
          <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>{t('profile.workspace.homeHint')}</div>
          <div style={{ flex: 1, minHeight: 0 }}>
            {fileLoading
              ? <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextTertiary }}>{t('common.loading')}</div>
              : (
                <Suspense fallback={<div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextTertiary }}>{t('common.loading')}</div>}>
                  <CodeEditor value={homeText} language="yaml" onChange={setHomeText} height="100%" />
                </Suspense>
              )}
          </div>
          <div>
            <Button type="primary" loading={fileSaving} onClick={() => void saveHome()}>{t('common.save')}</Button>
          </div>
        </div>
      )}

      {section === 'diagnostics' && (
        <div>
          {validation === null
            ? <div style={{ color: token.colorTextTertiary }}>{validating ? t('common.loading') : t('profile.workspace.noReport')}</div>
            : (
              <Space orientation="vertical" size="small" style={{ width: '100%' }}>
                <Alert type={validation.ok ? 'success' : 'error'} showIcon title={validation.ok ? t('profile.workspace.ok') : t('profile.workspace.problems')} />
                {validation.manifestError !== undefined && <Alert type="error" showIcon title={t('profile.workspace.manifestError')} description={validation.manifestError} />}
                {validation.patchError !== undefined && <Alert type="error" showIcon title={t('profile.workspace.patchError')} description={validation.patchError} />}
                {validation.conflicts.length > 0 && (
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      {t('profile.detail.insertConflictTitle')}（{validation.conflicts.length}）
                      <Button type="link" size="small" style={{ padding: 0, marginInlineStart: 8 }} onClick={() => setConflictsOpen(open => !open)}>
                        {conflictsOpen ? t('common.collapse') : t('common.expand')}
                      </Button>
                    </div>
                    {conflictsOpen && (
                      <ul style={{ margin: 0, paddingInlineStart: 18, maxHeight: 240, overflowY: 'auto' }}>
                        {validation.conflicts.map(c => <li key={c.id}><code>{c.id}</code> — {c.layers.map(conflictLayerLabel).join(' + ')}</li>)}
                      </ul>
                    )}
                  </div>
                )}
                {validation.missingBundles.length > 0 && (
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('profile.workspace.missingBundles')}</div>
                    <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM }}>{validation.missingBundles.join('、')}</div>
                  </div>
                )}
                {validation.unclaimedBundles.length > 0 && (
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('profile.workspace.unclaimedBundles')}</div>
                    <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM }}>{validation.unclaimedBundles.join('、')}</div>
                  </div>
                )}
              </Space>
            )}
        </div>
      )}
            </div>
          </Panel>
        </div>

        {inspectorOpen && (
          <div style={{ width: 280, flexShrink: 0, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: token.paddingSM }}>
            <div style={{ fontWeight: 600, color: token.colorText }}>{t('profile.workspace.inspector')}</div>
            {validation === null
              ? <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>{validating ? t('common.loading') : t('profile.workspace.noReport')}</div>
              : (
                <>
                  <Alert type={validation.ok ? 'success' : 'error'} showIcon title={validation.ok ? t('profile.workspace.ok') : t('profile.workspace.problems')} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>
                    <span>{t('profile.workspace.summaryBundles', { count: bundles.length })}</span>
                    <span>{t('profile.workspace.summaryPatchRows', { count: profileLayer?.rows.length ?? 0 })}</span>
                    <span>{t('profile.workspace.summaryDeps', { count: dependencies.length })}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: token.fontSizeSM }}>
                    {validation.manifestError !== undefined && issueRow(t('profile.workspace.manifestError'), undefined, () => setSection('manifest'))}
                    {validation.patchError !== undefined && issueRow(t('profile.workspace.patchError'), undefined, () => setSection('patch'))}
                    {validation.conflicts.length > 0 && issueRow(t('profile.detail.insertConflictTitle'), validation.conflicts.length, () => { setSection('diagnostics'); setConflictsOpen(true) })}
                    {validation.missingBundles.length > 0 && issueRow(t('profile.workspace.missingBundles'), validation.missingBundles.length, () => setSection('bundles'))}
                    {validation.unclaimedBundles.length > 0 && issueRow(t('profile.workspace.unclaimedBundles'), validation.unclaimedBundles.length, () => setSection('bundles'))}
                  </div>
                  <Space size={8}>
                    <Button size="small" onClick={revalidate} loading={validating}>{t('profile.workspace.validate')}</Button>
                    <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void revealProfile()}>{t('profile.workspace.reveal')}</Button>
                  </Space>
                </>
              )}
          </div>
        )}
      </div>

      <ScrollModal title={activeLayer !== undefined ? layerLabel(activeLayer) : ''} open={openLayer !== null} footer={null} onCancel={() => setOpenLayer(null)} width={MODAL.wide} bodyMax={440}>
        {activeLayer?.source === 'profile' && (
          <Button type="dashed" block style={{ marginBottom: token.paddingSM }} onClick={() => setNewRowOpen(true)}>{t('profile.detail.newRow')}</Button>
        )}
        {activeLayer !== undefined && renderRows(activeLayer)}
      </ScrollModal>

      <Modal title={editor !== null ? (editor.kind === 'config' ? t('profile.detail.editor.configTitle', { id: editor.id }) : t('profile.detail.editor.insertTitle', { id: editor.id })) : ''} open={editor !== null} okText={t('common.save')} onOk={() => void submit()} onCancel={() => setEditor(null)} confirmLoading={saving} destroyOnHidden width={MODAL.wide}>
        <Space orientation="vertical" style={{ width: '100%' }} size="small">
          {editor?.overlap !== null && (
            <Alert type="warning" showIcon title={t('profile.detail.editor.overlap', { owner: editor?.overlap })} description={t('profile.detail.editor.overlapDesc')} />
          )}
          {editor?.kind === 'config' ? (
            <>
              <FieldLabel>{t('profile.detail.editor.configReplaces')}</FieldLabel>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: token.paddingSM, marginTop: token.paddingSM }}>
                <div>
                  <FieldLabel>{t('profile.detail.editor.default')}</FieldLabel>
                  <pre style={{ margin: 0, minHeight: 180, maxHeight: 320, overflowY: 'auto', background: token.colorFillTertiary, padding: token.paddingSM, borderRadius: token.borderRadius, fontSize: token.fontSizeSM, lineHeight: '1.5' }}>
                    {cfgDefault === '' ? <span style={{ color: token.colorTextTertiary }}>{t('profile.detail.editor.noDefault')}</span> : cfgDefault.split('\n').map((line, i) => {
                      const differs = !editText.split('\n').includes(line) && editText.trim() !== ''
                      return <div key={i} style={{ background: differs ? 'rgba(255,77,79,0.16)' : undefined, whiteSpace: 'pre' }}>{line}</div>
                    })}
                  </pre>
                </div>
                <div>
                  <FieldLabel>{t('profile.detail.editor.override')}</FieldLabel>
                  <Input.TextArea rows={8} value={editText} onChange={e => setEditText(e.target.value)} placeholder={'key: value\nnested:\n  a: 1'} style={{ maxHeight: 320 }} />
                </div>
              </div>
            </>
          ) : (
            <>
              <FieldLabel>{t('profile.detail.editor.insertList')}</FieldLabel>
              <Input.TextArea rows={6} value={editText} onChange={e => setEditText(e.target.value)} placeholder={t('profile.detail.editor.insertPlaceholder')} />
            </>
          )}
        </Space>
      </Modal>

      <Modal title={t('profile.detail.newRowModalTitle')} open={newRowOpen} okText={t('profile.create.create')} onOk={() => void submitNew()} onCancel={() => setNewRowOpen(false)} destroyOnHidden width={MODAL.wide}>
        <Space orientation="vertical" style={{ width: '100%' }} size="small">
          <div><FieldLabel>{t('profile.detail.newRow.id')}</FieldLabel><Input value={newRowId} onChange={e => setNewRowId(e.target.value)} placeholder="- id: xxx" /></div>
          <div><FieldLabel>{t('profile.detail.newRow.status')}</FieldLabel><Select value={newRowDisabled} onChange={setNewRowDisabled} style={{ width: '100%' }} options={[{ value: false, label: t('profile.detail.newRow.enabled') }, { value: true, label: t('profile.detail.newRow.disabled') }]} /></div>
          <div><FieldLabel>{t('profile.detail.newRow.config')}</FieldLabel><Input.TextArea rows={4} value={newRowConfig} onChange={e => setNewRowConfig(e.target.value)} placeholder={'key: value\nnested:\n  a: 1'} /></div>
          <div><FieldLabel>{t('profile.detail.newRow.insert')}</FieldLabel><Input.TextArea rows={3} value={newRowInsert} onChange={e => setNewRowInsert(e.target.value)} placeholder={t('profile.detail.editor.insertPlaceholder')} /></div>
        </Space>
      </Modal>
      <Modal title={t('profile.detail.sourceTitle')} open={sourceOpen} okText={t('common.save')} onOk={() => void saveSource()} onCancel={() => setSourceOpen(false)} confirmLoading={sourceSaving} width={MODAL.wide} destroyOnHidden>
        {sourceLoading
          ? <div style={{ height: 420, display: 'flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextTertiary }}>{t('common.loading')}</div>
          : (
            <Suspense fallback={<div style={{ height: 420, display: 'flex', alignItems: 'center', justifyContent: 'center', color: token.colorTextTertiary }}>{t('common.loading')}</div>}>
              <CodeEditor value={sourceText} language="yaml" onChange={setSourceText} height={420} />
            </Suspense>
          )}
      </Modal>

      <Modal title={t('profile.workspace.renameTitle')} open={renameOpen} okText={t('common.save')} onOk={() => void doRename()} onCancel={() => setRenameOpen(false)} confirmLoading={renaming} width={MODAL.narrow} destroyOnHidden>
        <FieldLabel>{t('profile.workspace.renameLabel')}</FieldLabel>
        <Input value={renameValue} onChange={e => setRenameValue(e.target.value)} onPressEnter={() => void doRename()} placeholder={t('profile.create.namePlaceholder')} />
      </Modal>

      <Modal title={t('profile.workspace.transferTitle')} open={transferOpen} footer={null} onCancel={() => setTransferOpen(false)} width={MODAL.narrow} destroyOnHidden>
        <Space orientation="vertical" size="small" style={{ width: '100%' }}>
          <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>{t('profile.workspace.transferHint')}</div>
          <Select
            value={transferTarget}
            onChange={setTransferTarget}
            placeholder={t('profile.workspace.transferPlaceholder')}
            style={{ width: '100%' }}
            options={transferTargets.map(p => ({ value: p, label: p }))}
          />
          <Space>
            <Button type="primary" disabled={transferTarget === undefined} loading={transferBusy} onClick={() => void doTransfer(false)}>{t('profile.workspace.transferCopy')}</Button>
            <Button danger disabled={transferTarget === undefined} loading={transferBusy} onClick={() => void doTransfer(true)}>{t('profile.workspace.transferMove')}</Button>
          </Space>
        </Space>
      </Modal>

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

/** One sortable bundle row (dnd-kit) inside the Bundles modal — drag via the
 * handle on the left; the version controls on the right stay click-only. Only a
 * store/npm-backed layer can be re-versioned; an in-box (`dsh`) or local layer
 * is read-only, with the reason in a tooltip. */
function SortableBundle({ bundle, info, onRemove, onReplace, onRelink }: {
  bundle: string
  info?: ProfileBundleInfo
  onRemove: (b: string) => void
  onReplace: (b: string) => void
  onRelink: (b: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: bundle })
  const source = info?.source ?? 'dsh'
  const replaceable = source === 'store' || source === 'npm'
  const readonlyHint = source === 'dsh' ? t('profile.bundle.followInstall') : t('profile.bundle.localPath')
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: transform !== null ? CSS.Transform.toString(transform) : undefined,
        transition,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        background: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorSplit}`,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 1 : undefined,
      }}
    >
      <span
        {...attributes}
        {...listeners}
        style={{ cursor: 'grab', flexShrink: 0, touchAction: 'none', color: token.colorTextTertiary }}
      >
        ⠿
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {bundle}
      </span>
      {info?.version !== undefined && info.version !== '' && (
        <Tag style={{ flexShrink: 0, marginInlineEnd: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>@{info.version}</Tag>
      )}
      <Tooltip title={replaceable ? undefined : readonlyHint}>
        <Tag color={BUNDLE_SOURCE_COLORS[source]} style={{ flexShrink: 0, marginInlineEnd: 0 }}>
          {t(`profile.bundle.source.${source}`)}
        </Tag>
      </Tooltip>
      <Tooltip title={replaceable ? undefined : readonlyHint}>
        <span>
          <Button size="small" disabled={!replaceable} onClick={() => onReplace(bundle)}>{t('profile.bundle.replace')}</Button>
        </span>
      </Tooltip>
      {source === 'local' && (
        <Button size="small" onClick={() => onRelink(bundle)}>{t('profile.bundle.relink')}</Button>
      )}
      <Button size="small" danger onClick={() => onRemove(bundle)}>{t('profile.detail.removeBundle')}</Button>
    </div>
  )
}