/**
 * 预设 — one dsh's agent presets, as a roster.
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
import {
  Alert, Button, Dropdown, List, Popover, Skeleton, Space, Tag, Tooltip, Typography, message, theme,
} from 'antd'
import {
  CodeOutlined, DownOutlined, FolderOpenOutlined, InfoCircleOutlined, PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import AppShell from '../components/AppShell.tsx'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
import EmptyState from '../components/EmptyState.tsx'
import NavList from '../components/NavList.tsx'
import Panel from '../components/Panel.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import { PresetCreateModal, PresetMetaModal, type PresetCreateMode } from './presets/PresetModals.tsx'
import type {
  DshEntry, PresetGrade, PresetListing, PresetMetaInput, PresetRow,
} from '../../../shared/types.ts'

/** Beyond this the description is cut short and offered in full on hover, so a
 * verbose preset cannot push the rest of the row out of view. */
const DESCRIPTION_CLAMP = 78

/** The shipped preset a minimal instance starts from: the deployment's own
 * smallest composition, and an id the host's own display table knows by name. */
const MINIMAL_PRESET_ID = 'minimal'

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
  // The open create dialog and what it opens on, or null while it is closed.
  const [create, setCreate] = useState<{ mode: PresetCreateMode; from: string } | null>(null)

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

  // The minimal starting point is the SHIPPED one: a user directory that happens
  // to be named `minimal` is not what "minimal instance" means, and a broken one
  // would only create another broken copy.
  const minimalId = presets
    .find(preset => preset.id === MINIMAL_PRESET_ID && preset.trust === 'system' && preset.broken === undefined)
    ?.id ?? null

  /** The minimal instance: a fresh preset off the deployment's smallest one. */
  const createPreset = async (mode: PresetCreateMode, fromId: string, toId: string, name: string): Promise<void> => {
    if (selectedId === undefined) return
    setBusy('create')
    const r = await window.api.preset.copy(selectedId, fromId, toId, name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('preset.create.done', { id: toId }))
    setCreate(null)
    await load(selectedId)
  }

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

  const remove = async (preset: PresetRow): Promise<void> => {
    if (selectedId === undefined) return
    // The confirmation dialog is already gone by now, so the spinner on the
    // refresh button is what says the recycle-bin move is still running.
    setLoading(true)
    const r = await window.api.preset.remove(selectedId, preset.id)
    setLoading(false)
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

  /** What the row's menu offers. A built-in preset keeps only the copy, since
   * every other entry would write to a directory the deployment owns. */
  const actionsFor = (preset: PresetRow): MenuAction[] => {
    const actions: MenuAction[] = []
    if (preset.editable) actions.push({ key: 'edit', label: t('preset.edit') })
    actions.push({ key: 'copy', label: t('preset.copy') })
    if (preset.editable) {
      actions.push({
        key: 'delete',
        label: t('preset.delete'),
        danger: true,
        confirmText: t('preset.deleteConfirm', { id: preset.id }),
      })
    }
    return actions
  }

  const act = (preset: PresetRow, key: string): void => {
    if (key === 'edit') setEditing(preset)
    else if (key === 'copy') setCreate({ mode: 'copy', from: preset.id })
    else void remove(preset)
  }

  /** One row: what the preset says about itself, how it grades, and the two
   * controls the launcher offers on it — open it, or act on it. */
  const row = (preset: PresetRow): ReactNode => {
    const description = preset.description ?? t('preset.noDescription')
    const text = (
      <div
        style={{
          marginTop: 4,
          color: token.colorTextSecondary,
          maxWidth: `${String(DESCRIPTION_CLAMP)}ch`,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {description}
      </div>
    )
    return (
      <List.Item key={preset.id}>
        <div style={{ display: 'flex', gap: token.paddingLG, width: '100%', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Space size={8} wrap>
              <Typography.Text strong style={{ fontSize: token.fontSizeLG }}>
                {preset.name ?? preset.id}
              </Typography.Text>
              <Typography.Text code type="secondary">{preset.id}</Typography.Text>
              {/* Why a built-in preset offers no edit is worth saying out loud:
                  its row menu simply has one entry fewer, with no reason. */}
              <Tooltip title={preset.editable ? undefined : t('preset.readOnlyHint')}>
                <Tag>{t(preset.trust === 'user' ? 'preset.sourceUser' : 'preset.sourceSystem')}</Tag>
              </Tooltip>
              <Typography.Text type="secondary">{t('preset.priority', { value: preset.order ?? '—' })}</Typography.Text>
              {preset.broken === undefined
                ? null
                : <Tooltip title={preset.broken}><Tag color="error">{t('preset.broken')}</Tag></Tooltip>}
            </Space>
            {description.length > DESCRIPTION_CLAMP ? <Tooltip title={description}>{text}</Tooltip> : text}
            <Space size={4} wrap style={{ marginTop: 8 }}>
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
          <Space size={4} style={{ flexShrink: 0 }}>
            {/* One entry point for the two editors: opening a preset is one
                decision, and the row should not spend two icons on it. */}
            <Dropdown
              trigger={['click']}
              placement="bottomRight"
              menu={{
                items: [
                  { key: 'reveal', label: t('preset.reveal'), icon: <FolderOpenOutlined /> },
                  { key: 'editor', label: t('preset.openEditor'), icon: <CodeOutlined /> },
                ],
                onClick: ({ key }) => void open(preset, key === 'editor'),
              }}
            >
              <Button size="small" aria-label={`${t('preset.open')}: ${preset.id}`}>
                {t('preset.open')}
                <DownOutlined style={{ fontSize: 10 }} />
              </Button>
            </Dropdown>
            <ConfirmMenu actions={actionsFor(preset)} onAction={key => act(preset, key)} />
          </Space>
        </div>
      </List.Item>
    )
  }

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
      <Panel
        pad={false}
        title={t('preset.summary', { presets: presets.length, profiles: profiles.length })}
        description={t('preset.legend')}
      >
        {/* antd's List.Item pads itself `12px 0`, so without this the rows would
            sit flush against the panel while its own header is inset 16px. The
            inset lives on the body rather than the rows, which keeps the
            separators inside the same box as the text. */}
        <div style={{ padding: `0 ${String(token.padding)}px` }}>
          <List dataSource={presets} rowKey="id" renderItem={row} />
        </div>
      </Panel>
    )
  }

  const roots = listing?.roots ?? []

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
          description={t('preset.desc')}
          extra={(
            <Space size={8}>
              {/* Long absolute paths belong behind a click, not wrapped across
                  the header where they would dominate the page. */}
              <Popover
                trigger="click"
                placement="bottomRight"
                title={t('preset.rootsTitle')}
                content={(
                  <Space direction="vertical" size={10} style={{ maxWidth: 460 }}>
                    {roots.map(root => (
                      <div key={root.path}>
                        <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
                          {t(root.writable ? 'preset.rootUser' : 'preset.rootSystem')}
                          {root.exists ? '' : ` · ${t('preset.rootMissing')}`}
                        </div>
                        <Typography.Text
                          code
                          copyable={{ text: root.path }}
                          style={{ fontSize: token.fontSizeSM, wordBreak: 'break-all' }}
                        >
                          {root.path}
                        </Typography.Text>
                      </div>
                    ))}
                  </Space>
                )}
              >
                <Button size="small" icon={<InfoCircleOutlined />}>{t('preset.location')}</Button>
              </Popover>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={loading}
                disabled={selectedId === undefined}
                onClick={() => { if (selectedId !== undefined) void load(selectedId) }}
              >
                {t('common.refresh')}
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                disabled={presets.length === 0}
                onClick={() => setCreate({ mode: 'minimal', from: presets[0]?.id ?? '' })}
              >
                {t('preset.new')}
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

      <PresetCreateModal
        open={create !== null}
        initialMode={create?.mode ?? 'minimal'}
        presets={presets}
        minimalId={minimalId}
        defaultFrom={create?.from ?? ''}
        busy={busy === 'create'}
        onCancel={() => setCreate(null)}
        onSubmit={(mode, fromId, toId, name) => void createPreset(mode, fromId, toId, name)}
      />
    </AppShell>
  )
}
