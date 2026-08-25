import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Button, Input, List, Modal, Select, Space, Tag, theme, message,
} from 'antd'
import { FileTextOutlined } from '@ant-design/icons'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import type { ProfileDetail, ProfileLayer, RowCreateInput } from '../../../shared/types.ts'
import ActionCard from '../components/ActionCard.tsx'
import FieldLabel from '../components/FieldLabel.tsx'
import Loadable from '../components/Loadable.tsx'
import ScrollModal from '../components/ScrollModal.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import StatusTag from '../components/StatusTag.tsx'
import { MODAL } from '../theme.ts'

interface Props {
  name: string
  /** Called after this view mutates profile config, so the owner can refresh
   * aggregate state (e.g. the "missing bundles" hint). */
  onChanged?: () => void
}

type EditKind = 'config' | 'insert'

interface Editor {
  id: string
  kind: EditKind
  overlap: string | null
}

export default function ProfileDetailView({ name, onChanged }: Props) {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  // Self-managed data: the panel stays mounted across selection changes; only
  // this state updates (stale-guarded), so fast switching never remounts.
  const [detail, setDetail] = useState<ProfileDetail | null>(null)
  const [layers, setLayers] = useState<ProfileLayer[] | null>(null)
  const [loading, setLoading] = useState(true)

  const [openBlock, setOpenBlock] = useState<'bundles' | 'deps' | null>(null)
  const [openLayer, setOpenLayer] = useState<number | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [editText, setEditText] = useState('')
  const [cfgDefault, setCfgDefault] = useState('')
  const [saving, setSaving] = useState(false)
  const [reconciling, setReconciling] = useState(false)

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

  // A bumped sequence guards the last-write-wins: whenever `name` changes or a
// handler triggers a refresh, every in-flight load past the newer seq is
// discarded so a stale response can't overwrite fresher data (e.g. after a fast
// A→B profile switch).
const loadSeq = useRef(0)
  const load = async (): Promise<void> => {
    const seq = ++loadSeq.current
    if (name === '') { setDetail(null); setLayers(null); setLoading(false); return }
    setLoading(true)
    const [detailRes, layersRes] = await Promise.all([
      window.api.loadProfile(name),
      window.api.layers(name),
    ])
    if (seq !== loadSeq.current) return // a newer load superseded this one
    if (detailRes.ok) setDetail(detailRes.value)
    if (layersRes.ok) setLayers(layersRes.value)
    setLoading(false)
  }

  useEffect(() => {
    setDetail(null)
    setLayers(null)
    setLoading(true)
    if (name === '') { setLoading(false); return undefined }
    void load()
  }, [name])

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
    const result = await window.api.setDisabled(name, id, disabled)
    if (!result.ok) { void message.error(apiErrorText(result)); return }
    void load()
    onChanged?.()
  }
  const toggleHome = async (id: string, disabled: boolean): Promise<void> => {
    const result = await window.api.home.setDisabled(id, disabled)
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
      void window.api.configInfo(name, id).then(result => {
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
      result = await window.api.setRowConfig(name, editor.id, editText)
    } else {
      const items = editText.split('\n').map(line => line.trim()).filter(Boolean)
      if (items.length === 0) { void message.warning(t('profile.detail.insertEmpty')); setSaving(false); return }
      result = await window.api.addRow(name, { id: editor.id, insert: items })
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
    const result = await window.api.addRow(name, row)
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
        const result = await window.api.copyRow(name, bundle, id)
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
        const result = await window.api.removeRow(name, id)
        if (!result.ok) return void message.error(apiErrorText(result))
        void load()
        void message.success(t('profile.detail.coverRemoved'))
        onChanged?.()
      },
    })
  }

  const reconcileNow = async (): Promise<void> => {
    setReconciling(true)
    const result = await window.api.reconcileBundles(name)
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
    const result = await window.api.openPatchSource(name)
    if (!result.ok) void message.error(apiErrorText(result))
  }

  const removeBundleRow = (bundle: string): void => {
    Modal.confirm({
      title: t('profile.detail.removeBundle'),
      content: t('profile.detail.removeBundleConfirm', { profile: name, bundle }),
      okText: t('profile.detail.remove'),
      okButtonProps: { danger: true },
      onOk: async () => {
        const result = await window.api.removeBundle(name, bundle)
        if (!result.ok) return void message.error(apiErrorText(result))
        void load()
        onChanged?.()
        void message.success(t('profile.detail.bundleRemoved', { bundle }))
      },
    })
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
      const result = await window.api.reorderBundles(name, String(active.id), to)
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

  if (name === '') return null

  return (
    <Loadable loading={loading}>
    <div>
      <SectionHeading title={t('profile.detail.overview')} extra={(
        <Space size={8}>
          <Button size="small" icon={<FileTextOutlined />} onClick={() => void openPatchSource()}>{t('profile.detail.openPatchSource')}</Button>
          <Button size="small" onClick={() => void reconcileNow()} loading={reconciling}>{t('profile.detail.reconcile')}</Button>
        </Space>
      )} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: token.paddingSM, marginBottom: token.paddingLG }}>
        {blockButton(t('profile.detail.bundles'), t('profile.detail.nBundlesMeta', { count: bundles.length }), () => setOpenBlock('bundles'))}
        {blockButton(t('profile.detail.deps'), t('profile.detail.nDepsMeta', { count: dependencies.length }), () => setOpenBlock('deps'))}
      </div>

      <div style={{ fontSize: token.fontSizeLG, fontWeight: 600, color: token.colorText, marginBottom: token.paddingSM }}>{t('profile.detail.stack')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: token.paddingSM }}>
        {(layers ?? []).map((layer, i) => (
          blockButton(
            `${i + 1}. ${layerLabel(layer)}`,
            layer.source === 'profile' ? t('profile.detail.layerMetaEditable', { count: layer.rows.length }) : t('profile.detail.layerMeta', { count: layer.rows.length }),
            () => setOpenLayer(i),
          )
        ))}
      </div>

      <ScrollModal title={t('profile.detail.bundlesModal')} open={openBlock === 'bundles'} footer={null} width={MODAL.wide} onCancel={() => setOpenBlock(null)} bodyMax="md">
          {bundles.length === 0 ? <div style={{ color: token.colorTextTertiary }}>{t('common.none')}</div> : (
            <DndContext collisionDetection={closestCenter} autoScroll={false} onDragEnd={onDragEnd}>
                <SortableContext items={bundles} strategy={verticalListSortingStrategy}>
                  {bundles.map(bundle => (
                    <SortableBundle key={bundle} bundle={bundle} onRemove={removeBundleRow} />
                  ))}
                </SortableContext>
              </DndContext>
          )}
      </ScrollModal>

      <ScrollModal title={t('profile.detail.deps')} open={openBlock === 'deps'} footer={null} width={MODAL.wide} onCancel={() => setOpenBlock(null)} bodyMax="md">
          {dependencies.length === 0 ? <div style={{ color: token.colorTextTertiary }}>{t('common.none')}</div> : (
            <List size="small" dataSource={dependencies} renderItem={dependency => <List.Item key={dependency}>{dependency}</List.Item>} />
          )}
      </ScrollModal>

      <ScrollModal title={activeLayer !== undefined ? layerLabel(activeLayer) : ''} open={openLayer !== null} footer={null} onCancel={() => setOpenLayer(null)} width={MODAL.wide} bodyMax={440}>
        {activeLayer?.source === 'profile' && (
          <Button type="dashed" block style={{ marginBottom: token.paddingSM }} onClick={() => setNewRowOpen(true)}>{t('profile.detail.newRow')}</Button>
        )}
        {activeLayer !== undefined && renderRows(activeLayer)}
      </ScrollModal>

      <Modal title={editor !== null ? (editor.kind === 'config' ? t('profile.detail.editor.configTitle', { id: editor.id }) : t('profile.detail.editor.insertTitle', { id: editor.id })) : ''} open={editor !== null} okText={t('common.save')} onOk={() => void submit()} onCancel={() => setEditor(null)} confirmLoading={saving} destroyOnClose width={MODAL.wide}>
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          {editor?.overlap !== null && (
            <Alert type="warning" showIcon message={t('profile.detail.editor.overlap', { owner: editor?.overlap })} description={t('profile.detail.editor.overlapDesc')} />
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

      <Modal title={t('profile.detail.newRowModalTitle')} open={newRowOpen} okText={t('profile.create.create')} onOk={() => void submitNew()} onCancel={() => setNewRowOpen(false)} destroyOnClose width={MODAL.wide}>
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          <div><FieldLabel>{t('profile.detail.newRow.id')}</FieldLabel><Input value={newRowId} onChange={e => setNewRowId(e.target.value)} placeholder="- id: xxx" /></div>
          <div><FieldLabel>{t('profile.detail.newRow.status')}</FieldLabel><Select value={newRowDisabled} onChange={setNewRowDisabled} style={{ width: '100%' }} options={[{ value: false, label: t('profile.detail.newRow.enabled') }, { value: true, label: t('profile.detail.newRow.disabled') }]} /></div>
          <div><FieldLabel>{t('profile.detail.newRow.config')}</FieldLabel><Input.TextArea rows={4} value={newRowConfig} onChange={e => setNewRowConfig(e.target.value)} placeholder={'key: value\nnested:\n  a: 1'} /></div>
          <div><FieldLabel>{t('profile.detail.newRow.insert')}</FieldLabel><Input.TextArea rows={3} value={newRowInsert} onChange={e => setNewRowInsert(e.target.value)} placeholder={t('profile.detail.editor.insertPlaceholder')} /></div>
        </Space>
      </Modal>
    </div>
    </Loadable>
  )
}

/** One sortable bundle row (dnd-kit) inside the Bundles modal — drag via the
 * handle on the left; the Remove button on the right stays click-only. */
function SortableBundle({ bundle, onRemove }: { bundle: string; onRemove: (b: string) => void }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: bundle })
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
      <Button size="small" danger onClick={() => onRemove(bundle)}>{t('profile.detail.removeBundle')}</Button>
    </div>
  )
}