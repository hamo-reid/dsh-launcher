/**
 * 预设 — one PROFILE's agent presets.
 *
 * dsh has shipped two preset models and this page serves both without asking
 * which one it is looking at: a preset is a DIRECTORY dsh scans (through
 * 0.1.5-rc.2), or a declaration ROW in one of the profile's composed patch
 * layers (0.2.0-rc.1 and later). The three things the page owns are the same
 * either way — the preset's id, name, description and priority, plus where its
 * definition lives. The plugin list is deliberately NOT edited here: it is the
 * preset, and the row's Open action hands it to the editor of your choice.
 *
 * The profile is the scope, not a filter, because the newer model makes the
 * roster a per-profile fact: two profiles of one dsh may select different bundle
 * versions, and a declaration in one profile's patch layer does not exist in
 * another's. The grade answers the question a version number cannot — can THIS
 * profile resolve the rows this preset would start — since a profile resolves
 * its own `node_modules` on top of the install chain.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Alert, Button, Dropdown, List, Popover, Select, Skeleton, Space, Tag, Tooltip, Typography, message, theme,
} from 'antd'
import {
  CodeOutlined, DownOutlined, FolderOpenOutlined, InfoCircleOutlined, PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import {
  canReaskProfile, profileScope, scopeNames, scopeProfile, type ProfileScope,
} from '../lib/profileScope.ts'
import { presetReadOnlyHintKey, presetRowActions, type PresetRowAction } from '../lib/presetRow.ts'
import { presetTakenIds } from '../lib/presetCreate.ts'
import AppShell from '../components/AppShell.tsx'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
import EmptyState from '../components/EmptyState.tsx'
import NavList from '../components/NavList.tsx'
import Panel from '../components/Panel.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import { PresetCreateModal, PresetMetaModal, type PresetCreateMode } from './presets/PresetModals.tsx'
import type {
  DshEntry, PresetGrade, PresetLegacyItem, PresetListItem, PresetListing, PresetMetaInput, PresetSource,
} from '../../../shared/types.ts'

/** Beyond this the description is cut short and offered in full on hover, so a
 * verbose preset cannot push the rest of the row out of view. */
const DESCRIPTION_CLAMP = 78

/** The shipped preset a minimal instance starts from: the deployment's own
 * smallest composition, and an id the host's own display table knows by name. */
const MINIMAL_PRESET_ID = 'minimal'

/** The sources panel scrolls past this many pixels. A 0.2.0-rc.1 profile lists ten
 * places, so the panel would otherwise outgrow the viewport on a short screen. */
const PLACE_PANEL_MAX_HEIGHT = 420

/** The locale key naming where one definition comes from. `as const` keeps the
 * values literal, which is what lets `t()` typecheck a looked-up key. */
const SOURCE_KEY = {
  package: 'preset.source.package',
  bundle: 'preset.source.bundle',
  profile: 'preset.source.profile',
  home: 'preset.source.home',
  'user-dir': 'preset.source.userDir',
} as const satisfies Record<PresetSource, string>

/** The label each row action wears. `as const` keeps the values literal, which is
 * what lets `t()` typecheck a looked-up key. */
const ACTION_KEY = {
  edit: 'preset.edit',
  copy: 'preset.copy',
  delete: 'preset.delete',
} as const satisfies Record<PresetRowAction, string>

/** One roster row's React identity. Not the preset id alone: a declaration that
 * could not name a preset borrows its loader row id as one, and that string can
 * equal the id of a preset that does name itself. Both rows are kept (the broken
 * one may not shadow a working preset, and must not be hidden either), so the key
 * has to tell them apart — location and the broken reason do. */
const rowKey = (preset: PresetListItem): string =>
  `${preset.id}\u0000${preset.location}\u0000${preset.broken ?? ''}`

export default function PresetsSection(): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [dshes, setDshes] = useState<DshEntry[]>([])
  const [dshLoading, setDshLoading] = useState(true)
  // Local view selection only — the launcher has no global "active dsh", so
  // this decides which roster is shown and nothing else.
  const [selectedId, setSelectedId] = useState<string>()
  // The profile names AND the chosen one are one value TAGGED with the dsh they
  // were read from: this page swaps dsh in place, so an untagged name would be
  // sent to a dsh that does not have it — which core refuses (`profile.notFound`).
  const [scope, setScope] = useState<ProfileScope | null>(null)
  const [listing, setListing] = useState<PresetListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState<PresetListItem | null>(null)
  // The open create dialog and what it opens on, or null while it is closed.
  const [create, setCreate] = useState<{ mode: PresetCreateMode; from: string } | null>(null)
  // Two in-flight sequences, each guarded: a response may only land for the
  // selection it was asked about.
  const profileRead = useRef(0)
  const listingRead = useRef(0)

  // The profile this page shows: `undefined` until the selected dsh's own name
  // list has arrived, and after that only ever a name that list confirmed. Every
  // write below passes THIS value, so the page can never ask about a profile the
  // selected dsh does not have.
  const profile = scopeProfile(scope, selectedId)
  const names = scopeNames(scope, selectedId)

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

  /** Read the selected dsh's profile names into the scope, keeping the remembered
   * name, and return them (a refused listing needs to know whether asking again
   * is worth it). A failed read writes nothing, so the page stays on "no profile
   * to show" instead of holding another dsh's names. */
  const readProfiles = useCallback(async (): Promise<readonly string[] | null> => {
    if (selectedId === undefined) { setScope(null); return null }
    const mine = profileRead.current + 1
    profileRead.current = mine
    const r = await window.api.dsh.profiles(selectedId)
    if (profileRead.current !== mine) return null
    if (!r.ok) { void message.error(apiErrorText(r)); return null }
    const fresh = r.value.map(p => p.name)
    setScope(prev => profileScope(selectedId, fresh, prev?.chosen))
    return fresh
  }, [selectedId])

  useEffect(() => { void readProfiles() }, [readProfiles])

  const load = useCallback(async (dshId: string, profileName: string): Promise<void> => {
    const mine = listingRead.current + 1
    listingRead.current = mine
    setLoading(true)
    const r = await window.api.preset.list(dshId, profileName)
    if (listingRead.current !== mine) return
    if (!r.ok) {
      // The remembered name is the thing most likely to have gone stale under this
      // page (the dsh's home moved, or the profile was deleted / renamed): re-read
      // the names, and when that changes the choice, let the effect reload through
      // the reconciled one instead of reporting a refusal the page caused itself.
      // A name still listed means the refusal is real, and a failed re-read says
      // nothing about the listing — both are reported as they came.
      const fresh = await readProfiles()
      if (listingRead.current !== mine) return
      if (fresh !== null && canReaskProfile(profileName, fresh)) return
      setLoading(false)
      setError(apiErrorText(r))
      setListing(null)
      return
    }
    setLoading(false)
    setError(null)
    setListing(r.value)
  }, [readProfiles])

  useEffect(() => {
    if (selectedId === undefined || profile === undefined) { setListing(null); return }
    // Drop the previous profile's roster first: a preset that means one thing
    // here and nothing there must never be shown against the new selection.
    setListing(null)
    setError(null)
    void load(selectedId, profile)
  }, [selectedId, profile, load])

  const selected = dshes.find(d => d.id === selectedId)
  const presets = listing?.presets ?? []
  const legacy = listing?.legacy ?? []
  const warnings = listing?.warnings ?? []
  const places = listing?.places ?? []
  const model = listing?.model ?? null

  /** Re-read the current profile, whatever the page last asked for. */
  const reload = useCallback(async (): Promise<void> => {
    if (selectedId !== undefined && profile !== undefined) await load(selectedId, profile)
  }, [selectedId, profile, load])

  // The minimal starting point is the SHIPPED one: a user directory that happens
  // to be named `minimal` is not what "minimal instance" means, and a broken one
  // would only create another broken copy.
  const minimalId = presets
    .find(preset => preset.id === MINIMAL_PRESET_ID && preset.trust === 'system' && preset.broken === undefined)
    ?.id ?? null

  // Every id the core will refuse a new preset under: the roster's, plus the
  // directories the retired root keeps — which the roster does not show, so a
  // dialog built from the roster alone offers a create that is certain to fail.
  const takenIds = presetTakenIds(presets, legacy)

  /** The minimal instance: a fresh preset off the deployment's smallest one. */
  const createPreset = async (mode: PresetCreateMode, fromId: string, toId: string, name: string): Promise<void> => {
    if (selectedId === undefined || profile === undefined) return
    setBusy('create')
    const r = await window.api.preset.copy(selectedId, profile, fromId, toId, name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('preset.create.done', { id: toId }))
    setCreate(null)
    await reload()
  }

  const saveMeta = async (meta: PresetMetaInput): Promise<void> => {
    if (selectedId === undefined || profile === undefined || editing === null) return
    setBusy('save')
    const r = await window.api.preset.saveMeta(selectedId, profile, editing.id, meta)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('preset.meta.saved'))
    setEditing(null)
    await reload()
  }

  const remove = async (preset: PresetListItem): Promise<void> => {
    if (selectedId === undefined || profile === undefined) return
    // The confirmation dialog is already gone by now, so the spinner on the
    // refresh button is what says the removal is still running.
    setLoading(true)
    const r = await window.api.preset.remove(selectedId, profile, preset.id)
    setLoading(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('preset.deleted', { id: preset.id }))
    await reload()
  }

  const migrate = async (item: PresetLegacyItem): Promise<void> => {
    if (selectedId === undefined || profile === undefined) return
    setBusy(`migrate:${item.id}`)
    const r = await window.api.preset.migrate(selectedId, profile, item.id)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('preset.legacyMigrated', { id: item.id }))
    await reload()
  }

  const open = async (preset: PresetListItem, editor: boolean): Promise<void> => {
    if (selectedId === undefined || profile === undefined) return
    const r = editor
      ? await window.api.preset.openEditor(selectedId, profile, preset.id)
      : await window.api.preset.reveal(selectedId, profile, preset.id)
    if (!r.ok) void message.error(apiErrorText(r))
  }

  /** This preset's grade under the profile the page is showing.
   *
   * By POSITION first: the listing grades exactly one profile, so its cells line
   * up with the roster one for one (`presetListing` builds both from the same
   * array). That matters because two roster rows can carry one id — a row that
   * could not name a preset borrows its loader row id, which may equal another
   * preset's id — and lookup by id would hand one row the other's verdict. The
   * id lookup stays as the fallback for a listing whose cells do not line up. */
  const gradeOf = (presetId: string, index: number): PresetGrade | undefined =>
    listing !== null && listing.grades.length === presets.length
      ? listing.grades[index]
      : listing?.grades.find(cell => cell.presetId === presetId)

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

  /** What the row's menu offers. A preset this page may not write keeps only the
   * copy — a copy lands in the profile's own layer, so it is allowed from any
   * source, and every other entry would write where the page may not. */
  const actionsFor = (preset: PresetListItem): MenuAction[] => presetRowActions(preset).map(key => ({
    key,
    label: t(ACTION_KEY[key]),
    ...(key === 'delete'
      ? { danger: true, confirmText: t('preset.deleteConfirm', { id: preset.id }) }
      : {}),
  }))

  const act = (preset: PresetListItem, key: string): void => {
    if (key === 'edit') setEditing(preset)
    else if (key === 'copy') setCreate({ mode: 'copy', from: preset.id })
    else void remove(preset)
  }

  /** One row: what the preset says about itself, how it grades here, and the two
   * controls the launcher offers on it — open it, or act on it. */
  const row = (preset: PresetListItem, index: number): ReactNode => {
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
    const cell = gradeOf(preset.id, index)
    // Why this row offers no edit. Not always "it is built-in": a declaration in
    // the machine-level home patch is the person's own and still not editable
    // here, so the reason has to be the row's own.
    const readOnlyHint = presetReadOnlyHintKey(preset)
    return (
      <List.Item key={rowKey(preset)}>
        <div style={{ display: 'flex', gap: token.paddingLG, width: '100%', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Space size={8} wrap>
              <Typography.Text strong style={{ fontSize: token.fontSizeLG }}>
                {preset.name ?? preset.id}
              </Typography.Text>
              <Typography.Text code type="secondary">{preset.id}</Typography.Text>
              {/* Why a preset offers no edit is worth saying out loud: its row
                  menu simply has one entry fewer, with no reason. */}
              <Tooltip title={readOnlyHint === undefined ? undefined : t(readOnlyHint)}>
                <Tag>{t(preset.trust === 'user' ? 'preset.sourceUser' : 'preset.sourceSystem')}</Tag>
              </Tooltip>
              {/* Where the definition lives. Two shipped presets and a local one
                  can share a name, and only this says which file to open. */}
              <Tooltip title={preset.bundle}>
                <Tag color="blue">{t(SOURCE_KEY[preset.source])}</Tag>
              </Tooltip>
              <Typography.Text type="secondary">{t('preset.priority', { value: preset.order ?? '—' })}</Typography.Text>
              <Tooltip title={gradeTip(cell)}>
                <Tag color={gradeColor(cell)}>{gradeText(cell)}</Tag>
              </Tooltip>
              {preset.broken === undefined
                ? null
                : <Tooltip title={preset.broken}><Tag color="error">{t('preset.broken')}</Tag></Tooltip>}
            </Space>
            {description.length > DESCRIPTION_CLAMP ? <Tooltip title={description}>{text}</Tooltip> : text}
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

  /**
   * The directories the retired root still holds. They are on disk and dsh does
   * not read them, so the page says so and offers the migration the host's own
   * documentation describes — leaving the directory itself alone.
   */
  const legacyBlock = (): ReactNode => {
    if (legacy.length === 0) return null
    return (
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: token.padding }}
        title={t('preset.legacyTitle')}
        description={(
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <span>{t('preset.legacyDesc')}</span>
            {legacy.map(item => (
              <div key={item.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography.Text strong>{item.name ?? item.id}</Typography.Text>
                <Typography.Text code type="secondary" copyable={{ text: item.dir }}>{item.id}</Typography.Text>
                {item.taken
                  ? <Tag>{t('preset.legacyTaken')}</Tag>
                  : null}
                {item.problem === undefined
                  ? null
                  : <Tooltip title={item.problem}><Tag color="error">{t('preset.legacyBroken')}</Tag></Tooltip>}
                <span style={{ flex: 1 }} />
                <Button
                  size="small"
                  type="primary"
                  ghost
                  disabled={item.taken || item.problem !== undefined}
                  loading={busy === `migrate:${item.id}`}
                  onClick={() => void migrate(item)}
                >
                  {t('preset.legacyMigrate')}
                </Button>
              </div>
            ))}
          </Space>
        )}
      />
    )
  }

  const body = (): ReactNode => {
    if (selectedId === undefined) {
      return <EmptyState title={t('preset.noDsh')} description={t('preset.noDshDesc')} />
    }
    if (profile === undefined) {
      return <EmptyState title={t('preset.noProfile')} description={t('preset.noProfileDesc')} />
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
              <Button size="small" onClick={() => void reload()}>{t('common.refresh')}</Button>
            </Space>
          )}
        />
      )
    }
    if (listing !== null && model === 'none') {
      return <EmptyState title={t('preset.noModel')} description={t('preset.noModelDesc')} />
    }
    if (loading && listing === null) {
      return (
        <Panel>
          <Skeleton active title={false} paragraph={{ rows: 5 }} />
        </Panel>
      )
    }
    if (presets.length === 0 && legacy.length === 0 && warnings.length === 0) {
      return <EmptyState title={t('preset.empty')} description={t('preset.emptyDesc')} />
    }
    if (presets.length === 0) {
      // Nothing to list, but the retired root or a duplicate id still has
      // something to say — that IS the page's content in this state.
      return (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {warningsBlock()}
          {legacyBlock()}
        </Space>
      )
    }
    return (
      <Panel
        pad={false}
        title={t('preset.summary', { presets: presets.length, profile: profile })}
        description={t(model === 'declaration' ? 'preset.legendDeclaration' : 'preset.legendDirectory')}
      >
        {/* antd's List.Item pads itself `12px 0`, so without this the rows would
            sit flush against the panel while its own header is inset 16px. The
            inset lives on the body rather than the rows, which keeps the
            separators inside the same box as the text. */}
        <div style={{ padding: `0 ${String(token.padding)}px` }}>
          {warningsBlock()}
          {legacyBlock()}
          <List dataSource={presets} rowKey={rowKey} renderItem={row} />
        </div>
      </Panel>
    )
  }

  /** A definition dsh takes but the page cannot list as a row — a preset id
   * declared twice, which dsh itself refuses at activation. */
  const warningsBlock = (): ReactNode => {
    if (warnings.length === 0) return null
    return (
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: token.padding }}
        title={t('preset.warningsTitle')}
        description={(
          <ul style={{ margin: 0, paddingInlineStart: token.padding }}>
            {warnings.map(line => <li key={line}>{line}</li>)}
          </ul>
        )}
      />
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
          description={t('preset.desc')}
          extra={(
            <Space size={8}>
              {/* The profile is the page's scope: on a dsh that declares its
                  presets, each profile composes its own roster. */}
              <Select
                size="small"
                style={{ minWidth: 140 }}
                value={profile}
                placeholder={t('preset.profile')}
                aria-label={t('preset.profile')}
                disabled={names.length === 0}
                onChange={(value: string) => setScope(prev => (prev === null ? null : { ...prev, chosen: value }))}
                options={names.map(name => ({ value: name, label: name }))}
              />
              {/* Long absolute paths belong behind a click, not wrapped across
                  the header where they would dominate the page. A 0.2.0-rc.1
                  profile lists ten places and several paths run past 150
                  characters, so the panel scrolls and both the source line and
                  the path stay on ONE line with an ellipsis; the full path is a
                  hover and a copy away. The scroll container carries its own
                  padding: the scrollbar sits inside, so the content needs a
                  wider right gutter to clear it. */}
              <Popover
                trigger="click"
                placement="bottomRight"
                title={t('preset.placesTitle')}
                content={(
                  <div style={{
                    width: 460,
                    maxHeight: PLACE_PANEL_MAX_HEIGHT,
                    overflowY: 'auto',
                    padding: '2px 16px 2px 4px',
                  }}>
                    <Space direction="vertical" size={10} style={{ width: '100%' }}>
                      {places.map(place => (
                        <div key={place.path} style={{ minWidth: 0 }}>
                          <div
                            style={{
                              color: token.colorTextSecondary,
                              fontSize: token.fontSizeSM,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t(SOURCE_KEY[place.source])}
                            {place.bundle === undefined ? '' : ` · ${place.bundle}`}
                            {place.writable ? '' : ` · ${t('preset.sourceSystem')}`}
                            {place.exists ? '' : ` · ${t('preset.placeMissing')}`}
                          </div>
                          {/* The path truncates on its own, with the copy control as a
                              SIBLING: putting `overflow: hidden` on the same element as
                              antd's copy button would clip the button too, and antd's own
                              ellipsis-with-copyable path measures in JS to reserve room for
                              it. The hover carries the full path; the copy button keeps
                              antd's own copy/copied tooltip. */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                            <Tooltip title={place.path}>
                              <span
                                style={{
                                  flex: '1 1 auto',
                                  minWidth: 0,
                                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                                  fontSize: token.fontSizeSM,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {place.path}
                              </span>
                            </Tooltip>
                            <Typography.Text
                              copyable={{ text: place.path }}
                              style={{ flexShrink: 0, fontSize: token.fontSizeSM }}
                            />
                          </div>
                        </div>
                      ))}
                    </Space>
                  </div>
                )}
              >
                {/* With no preset model mounted there are no sources either, so
                    the control is disabled rather than opening an empty list. */}
                <Button
                  size="small"
                  icon={<InfoCircleOutlined />}
                  disabled={places.length === 0}
                >
                  {t('preset.location')}
                </Button>
              </Popover>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={loading}
                disabled={profile === undefined}
                onClick={() => void reload()}
              >
                {t('common.refresh')}
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                disabled={presets.length === 0}
                onClick={() => setCreate({ mode: 'minimal', from: minimalId ?? presets[0]?.id ?? '' })}
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
        takenIds={takenIds}
        minimalId={minimalId}
        defaultFrom={create?.from ?? ''}
        busy={busy === 'create'}
        onCancel={() => setCreate(null)}
        onSubmit={(mode, fromId, toId, name) => void createPreset(mode, fromId, toId, name)}
      />
    </AppShell>
  )
}
