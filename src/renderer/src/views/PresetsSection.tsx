/**
 * 预设 — one dsh's agent presets, as a whole.
 *
 * A preset is a directory dsh discovers: its `agent.cordis.yml` is what mounts,
 * and the four things this page owns are its id, name, description and
 * priority. The composition is deliberately NOT edited here — every row opens
 * its directory in the file manager or VS Code, because a composition is a
 * Cordis file and a text editor is the tool for it.
 *
 * The grades are the point of the page: one preset can be fine under one
 * profile and short a handful of plugins under another, since a profile
 * resolves its own `node_modules` on top of the install chain. One tag per
 * profile says which, and hovering it names every row no resolver found.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Alert, Button, List, Popconfirm, Skeleton, Space, Tag, Tooltip, Typography, message, theme } from 'antd'
import { CodeOutlined, DeleteOutlined, FolderOpenOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import AppShell from '../components/AppShell.tsx'
import EmptyState from '../components/EmptyState.tsx'
import NavList from '../components/NavList.tsx'
import Panel from '../components/Panel.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import { PresetCopyModal, PresetMetaModal } from './presets/PresetModals.tsx'
import type {
  DshEntry, PresetGrade, PresetListing, PresetMetaInput, PresetRow,
} from '../../../shared/types.ts'

export default function PresetsSection(): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [dshes, setDshes] = useState<DshEntry[]>([])
  const [dshLoading, setDshLoading] = useState(true)
  // Local view selection only — the launcher has no global "active dsh", so
  // this decides which roster is shown and nothing else.
  const [selectedId, setSelectedId] = useState<string>()
  const [listing, setListing] = useState<PresetListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState<PresetRow | null>(null)
  // The id the copy dialog opens on, or null while it is closed.
  const [copyFrom, setCopyFrom] = useState<string | null>(null)

  const refreshDshes = useCallback(async (): Promise<void> => {
    const r = await window.api.dsh.list()
    if (!r.ok) { void message.error(apiErrorText(r)); setDshLoading(false); return }
    setDshes(r.value.dshes)
    setSelectedId(prev => (prev !== undefined && r.value.dshes.some(d => d.id === prev))
      ? prev
      : r.value.dshes[0]?.id)
    setDshLoading(false)
  }, [])

  useEffect(() => { void refreshDshes() }, [refreshDshes])

  const load = useCallback(async (dshId: string): Promise<void> => {
    setLoading(true)
    const r = await window.api.preset.list(dshId)
    setLoading(false)
    if (!r.ok) { setError(apiErrorText(r)); setListing(null); return }
    setError(null)
    setListing(r.value)
  }, [])

  useEffect(() => {
    if (selectedId === undefined) { setListing(null); return }
    // Drop the previous dsh's roster first: an id that means one thing here and
    // nothing there must never be shown against the new selection.
    setListing(null)
    setError(null)
    void load(selectedId)
  }, [selectedId, load])

  const selected = dshes.find(d => d.id === selectedId)
  const presets = listing?.presets ?? []
  const profiles = listing?.profiles ?? []

  const saveMeta = async (meta: PresetMetaInput): Promise<void> => {
    if (selectedId === undefined || editing === null) return
    setBusy('save')
    const r = await window.api.preset.saveMeta(selectedId, editing.id, meta)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('preset.meta.saved'))
    setEditing(null)
    await load(selectedId)
  }

  const copy = async (fromId: string, toId: string, name: string): Promise<void> => {
    if (selectedId === undefined) return
    setBusy('copy')
    const r = await window.api.preset.copy(selectedId, fromId, toId, name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('preset.copy.done', { id: toId }))
    setCopyFrom(null)
    await load(selectedId)
  }

  const remove = async (preset: PresetRow): Promise<void> => {
    if (selectedId === undefined) return
    setBusy(`remove:${preset.id}`)
    const r = await window.api.preset.remove(selectedId, preset.id)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('preset.deleted', { id: preset.id }))
    await load(selectedId)
  }

  const open = async (preset: PresetRow, editor: boolean): Promise<void> => {
    if (selectedId === undefined) return
    const r = editor
      ? await window.api.preset.openEditor(selectedId, preset.id)
      : await window.api.preset.reveal(selectedId, preset.id)
    if (!r.ok) void message.error(apiErrorText(r))
  }

  const gradeOf = (presetId: string, profile: string): PresetGrade | undefined =>
    listing?.grades.find(cell => cell.presetId === presetId && cell.profile === profile)

  /** What a grade reads as. An `incomplete` grade leads with the count, which is
   * the whole reason the tag is worth looking at. */
  const gradeText = (cell: PresetGrade | undefined): string => {
    if (cell === undefined) return t('preset.grade.unknown')
    if (cell.level === 'ok') return t('preset.grade.ok')
    if (cell.level === 'unusable') return t('preset.grade.unusable')
    return t('preset.grade.incomplete', { count: cell.missing.length })
  }

  const gradeColor = (cell: PresetGrade | undefined): string => {
    if (cell === undefined) return 'default'
    if (cell.level === 'ok') return 'success'
    return cell.level === 'incomplete' ? 'warning' : 'error'
  }

  /** The hover text of a grade: why it is unusable, or which rows are missing
   * and what the counting left out. */
  const gradeTip = (cell: PresetGrade | undefined): ReactNode => {
    if (cell === undefined) return t('preset.grade.unknownTip')
    if (cell.reason !== undefined) return cell.reason
    return (
      <div>
        <div>{t('preset.grade.counts', {
          checked: cell.checked, skipped: cell.skipped, conditional: cell.conditional,
        })}</div>
        {cell.missing.map(row => (
          <div key={row.label}>{row.label}：{row.name}</div>
        ))}
      </div>
    )
  }

  const row = (preset: PresetRow): ReactNode => (
    <List.Item key={preset.id}>
      <div style={{ display: 'flex', gap: token.padding, width: '100%', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Space size={6} wrap>
            <Typography.Text strong>{preset.name ?? preset.id}</Typography.Text>
            <Typography.Text code type="secondary">{preset.id}</Typography.Text>
            <Tag>{t(preset.trust === 'user' ? 'preset.sourceUser' : 'preset.sourceSystem')}</Tag>
            <Tag>{t('preset.priority', { value: preset.order ?? '—' })}</Tag>
            {preset.broken === undefined
              ? null
              : <Tooltip title={preset.broken}><Tag color="error">{t('preset.broken')}</Tag></Tooltip>}
          </Space>
          <div style={{ marginTop: 4, color: token.colorTextSecondary }}>
            {preset.description ?? t('preset.noDescription')}
          </div>
          <Space size={4} wrap style={{ marginTop: 6 }}>
            {profiles.length === 0
              ? <Typography.Text type="secondary">{t('preset.noProfiles')}</Typography.Text>
              : profiles.map(profile => {
                const cell = gradeOf(preset.id, profile)
                return (
                  <Tooltip key={profile} title={gradeTip(cell)}>
                    <Tag color={gradeColor(cell)}>{`${profile} · ${gradeText(cell)}`}</Tag>
                  </Tooltip>
                )
              })}
          </Space>
        </div>
        <Space size={4} wrap>
          <Tooltip title={preset.editable ? undefined : t('preset.readOnlyHint')}>
            <Button size="small" disabled={!preset.editable} onClick={() => setEditing(preset)}>
              {t('preset.edit')}
            </Button>
          </Tooltip>
          <Button size="small" onClick={() => setCopyFrom(preset.id)}>{t('preset.copy')}</Button>
          <Tooltip title={t('preset.reveal')}>
            <Button
              size="small"
              icon={<FolderOpenOutlined />}
              aria-label={`${t('preset.reveal')}: ${preset.id}`}
              onClick={() => void open(preset, false)}
            />
          </Tooltip>
          <Tooltip title={t('preset.openEditor')}>
            <Button
              size="small"
              icon={<CodeOutlined />}
              aria-label={`${t('preset.openEditor')}: ${preset.id}`}
              onClick={() => void open(preset, true)}
            />
          </Tooltip>
          {!preset.editable ? null : (
            <Popconfirm
              title={t('preset.deleteConfirm', { id: preset.id })}
              okText={t('common.delete')}
              cancelText={t('common.cancel')}
              onConfirm={() => void remove(preset)}
            >
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                loading={busy === `remove:${preset.id}`}
                aria-label={`${t('preset.delete')}: ${preset.id}`}
              />
            </Popconfirm>
          )}
        </Space>
      </div>
    </List.Item>
  )

  const body = (): ReactNode => {
    if (selectedId === undefined) {
      return <EmptyState title={t('preset.noDsh')} description={t('preset.noDshDesc')} />
    }
    if (error !== null) {
      return (
        <Alert
          type="error"
          showIcon
          title={t('preset.loadFailed')}
          description={(
            <Space direction="vertical" size={8}>
              <span>{error}</span>
              <Button size="small" onClick={() => void load(selectedId)}>{t('common.refresh')}</Button>
            </Space>
          )}
        />
      )
    }
    if (loading && listing === null) {
      return (
        <Panel>
          <Skeleton active title={false} paragraph={{ rows: 5 }} />
        </Panel>
      )
    }
    if (presets.length === 0) {
      return <EmptyState title={t('preset.empty')} description={t('preset.emptyDesc')} />
    }
    return (
      <Panel pad={false}>
        <List dataSource={presets} rowKey="id" renderItem={row} />
      </Panel>
    )
  }

  return (
    <AppShell
      sider={(
        <NavList
          items={dshes}
          keyOf={d => d.id}
          selectedKey={selectedId}
          onSelect={d => setSelectedId(d.id)}
          renderTitle={d => d.name}
          renderMeta={d => (d.version === '' ? d.execPath : d.version)}
          loading={dshLoading}
          empty={<EmptyState title={t('preset.noDsh')} description={t('preset.noDshDesc')} />}
        />
      )}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <SectionHeading
          title={selected === undefined ? t('preset.title') : t('preset.titleFor', { name: selected.name })}
          description={(
            <span>
              {t('preset.desc')}
              {(listing?.roots ?? []).map(root => (
                <span key={root.path}>
                  {' · '}
                  {t(root.writable ? 'preset.rootUser' : 'preset.rootSystem')}：
                  <Typography.Text code>{root.path}</Typography.Text>
                  {root.exists ? '' : ` (${t('preset.rootMissing')})`}
                </span>
              ))}
            </span>
          )}
          extra={(
            <Space size={8}>
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                disabled={presets.length === 0}
                onClick={() => setCopyFrom(presets[0]?.id ?? null)}
              >
                {t('preset.copy.add')}
              </Button>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={loading}
                disabled={selectedId === undefined}
                onClick={() => { if (selectedId !== undefined) void load(selectedId) }}
              >
                {t('common.refresh')}
              </Button>
            </Space>
          )}
        />
        {body()}
      </Space>

      <PresetMetaModal
        preset={editing}
        saving={busy === 'save'}
        onCancel={() => setEditing(null)}
        onSubmit={meta => void saveMeta(meta)}
      />

      <PresetCopyModal
        open={copyFrom !== null}
        presets={presets}
        defaultFrom={copyFrom ?? ''}
        busy={busy === 'copy'}
        onCancel={() => setCopyFrom(null)}
        onSubmit={(fromId, toId, name) => void copy(fromId, toId, name)}
      />
    </AppShell>
  )
}
