/**
 * Modals for moving between the launcher-global libraries and their targets:
 * applying a library MCP entry to a profile layer or the home layer, picking
 * an entry to add from a profile/dsh side, and installing a library skill
 * into a dsh's writable root.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Alert, Checkbox, Modal, Pagination, Radio, Select, Space, Tag, theme, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import FieldLabel from '../components/FieldLabel.tsx'
import EmptyState from '../components/EmptyState.tsx'
import SearchInput from '../components/SearchInput.tsx'
import { filterByQuery, pageOf, type RowFields } from '../lib/libraryPick.ts'
import { installCellState } from '../lib/skillInstallState.ts'
import type {
  McpApplyTarget, McpLibEntry, SkillLibEntry, SkillLibInstall, SkillLibOverviewRow,
} from '../../../shared/types.ts'

/** One dsh and the profiles it holds (from `plugins.installOptions`). */
export interface DshScope { id: string; name: string; profiles: string[] }

/**
 * The shared body of both "pick from the library" dialogs: a search field, one
 * page of rows, and the pager.
 *
 * Presentational and stateless on purpose — the dialog owns the query and the
 * page — so it can be server-rendered in a test: a `Modal` renders through a
 * portal, which a server render cannot produce at all (the same reason
 * `InstallSkillFields` below lives apart from its dialog).
 */
export function LibraryPicker<T>(props: {
  /** Rows to search and page — ALREADY narrowed by any toggle the dialog owns. */
  rows: readonly T[]
  /** Size of the library BEFORE that narrowing. 0 means the library is empty,
   * which is a different fact from "your filter/toggle hid everything". */
  total: number
  query: string
  onQuery: (query: string) => void
  page: number
  onPage: (page: number) => void
  /** The searchable text of one row. */
  fields: RowFields<T>
  keyOf: (row: T) => string
  renderRow: (row: T) => ReactNode
  /** Shown when the LIBRARY is empty — a different fact from "nothing matched". */
  empty: ReactNode
  /** Extra control beside the search box (e.g. "hide up-to-date"). */
  toolbar?: ReactNode
  searchPlaceholder: string
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  if (props.total === 0) return <>{props.empty}</>
  const slice = pageOf(filterByQuery(props.rows, props.query, props.fields), props.page)
  // Nothing left after the dialog's own toggle: the search box and the toggle
  // stay on screen, because unticking it is the only way out of this state.
  const toggledAll = props.rows.length === 0
  return (
    <Space orientation="vertical" size={8} style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <SearchInput
          value={props.query}
          onChange={props.onQuery}
          placeholder={props.searchPlaceholder}
          ariaLabel={props.searchPlaceholder}
          // The dialog exists to find one entry; typing is the first action, so the
          // cursor belongs here rather than on the close button.
          autoFocus
          style={{ maxWidth: 300 }}
        />
        {props.toolbar}
      </div>
      {toggledAll
        ? <EmptyState title={t('ext.lib.noneAvailable')} />
        : slice.items.length === 0
          ? <EmptyState title={t('ext.lib.noMatch', { query: props.query.trim() })} />
          : (
            <>
              {/* Cap the body and scroll INSIDE it: eight two-line skill rows are
                  taller than a small window, and a dialog that grows past the
                  viewport puts its own pager out of reach. */}
              <Space
                orientation="vertical"
                size={8}
                style={{ width: '100%', maxHeight: 'min(430px, 52vh)', overflowY: 'auto', paddingInlineEnd: 2 }}
              >
                {slice.items.map(row => <div key={props.keyOf(row)}>{props.renderRow(row)}</div>)}
              </Space>
              {slice.pages > 1 && (
                <Pagination
                  style={{ textAlign: 'center', marginTop: token.paddingSM }}
                  current={slice.page}
                  pageSize={slice.size}
                  total={slice.total}
                  showSizeChanger={false}
                  showTotal={total => t('ext.lib.total', { count: total })}
                  onChange={props.onPage}
                />
              )}
            </>
          )}
    </Space>
  )
}

/** Pick dsh + target layer for applying a library MCP entry. */
export function ApplyMcpModal(props: {
  open: boolean
  entry: McpLibEntry | null
  scopes: DshScope[]
  onCancel: () => void
  onApply: (target: McpApplyTarget) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [dshId, setDshId] = useState<string>()
  const [layer, setLayer] = useState<'profile' | 'home'>('profile')
  const [profile, setProfile] = useState<string>()

  // Reset to the first valid target whenever the dialog opens.
  useEffect(() => {
    if (!props.open) return
    setDshId(prev => (prev !== undefined && props.scopes.some(s => s.id === prev)) ? prev : props.scopes[0]?.id)
    setLayer('profile')
    setProfile(undefined)
  }, [props.open, props.scopes])

  useEffect(() => {
    const profiles = props.scopes.find(scope => scope.id === dshId)?.profiles ?? []
    setProfile(prev => (prev !== undefined && profiles.includes(prev)) ? prev : profiles[0])
  }, [props.scopes, dshId])

  const submit = (): void => {
    if (dshId === undefined) return
    if (layer === 'profile' && profile === undefined) return
    props.onApply({ dshId, layer, ...(layer === 'profile' ? { profile } : {}) })
  }

  return (
    <Modal
      open={props.open}
      title={t('ext.mcp.applyTitle', { name: props.entry?.serverName ?? '' })}
      okText={t('ext.mcp.apply')}
      cancelText={t('common.cancel')}
      onOk={submit}
      onCancel={props.onCancel}
      okButtonProps={{ disabled: dshId === undefined || (layer === 'profile' && profile === undefined) }}
      destroyOnHidden
    >
      {props.scopes.length === 0 ? (
        <EmptyState title={t('ext.target.noDsh')} />
      ) : (
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <FieldLabel>{t('ext.target.dsh')}</FieldLabel>
            <Select
              style={{ width: '100%' }}
              showSearch
              optionFilterProp="label"
              value={dshId}
              onChange={setDshId}
              options={props.scopes.map(scope => ({ value: scope.id, label: scope.name }))}
            />
          </div>
          <div>
            <FieldLabel>{t('ext.mcp.form.layer')}</FieldLabel>
            <Radio.Group
              value={layer}
              onChange={e => setLayer(e.target.value as 'profile' | 'home')}
              options={[
                { value: 'profile', label: t('ext.mcp.form.layerProfile', { profile: profile ?? '' }) },
                { value: 'home', label: t('ext.mcp.form.layerHome') },
              ]}
            />
            <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, marginTop: 4 }}>
              {layer === 'home' ? t('ext.mcp.form.layerHomeHint') : t('ext.mcp.form.layerProfileHint')}
            </div>
          </div>
          {layer === 'profile' && (
            <div>
              <FieldLabel>{t('ext.target.profile')}</FieldLabel>
              <Select
                style={{ width: '100%' }}
                showSearch
                optionFilterProp="label"
                value={profile}
                disabled={dshId === undefined}
                onChange={setProfile}
                options={(props.scopes.find(scope => scope.id === dshId)?.profiles ?? [])
                  .map(name => ({ value: name, label: name }))}
              />
            </div>
          )}
          <Alert type="info" showIcon title={t('ext.mcp.applyHint')} />
        </Space>
      )}
    </Modal>
  )
}

/** Pick a library MCP entry to add to a profile layer / the home layer. */
export function PickLibMcpModal(props: {
  open: boolean
  entries: McpLibEntry[]
  /** serverNames already present in the target layer — those rows are disabled. */
  appliedNames: string[]
  busy: string | null
  onCancel: () => void
  onPick: (entry: McpLibEntry) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [hideApplied, setHideApplied] = useState(false)

  // A fresh search each time the dialog opens: reopening on the previous query
  // reads as "the library only holds these few entries".
  useEffect(() => {
    if (!props.open) return
    setQuery('')
    setPage(1)
    setHideApplied(false)
  }, [props.open])
  // Narrowing the list must not strand the pager on a page that no longer exists.
  useEffect(() => { setPage(1) }, [query, hideApplied])

  // Everything already present in the target layer is disabled, so on a long
  // library the useful rows are buried. The toggle is a filter, not a delete:
  // the rows come back the moment it is unticked.
  const visible = hideApplied
    ? props.entries.filter(entry => !props.appliedNames.includes(entry.serverName))
    : props.entries

  const row = (entry: McpLibEntry): JSX.Element => {
    const applied = props.appliedNames.includes(entry.serverName)
    return (
      <div
        role="button"
        tabIndex={applied ? -1 : 0}
        aria-disabled={applied}
        onClick={() => { if (!applied && props.busy === null) props.onPick(entry) }}
        onKeyDown={event => {
          if ((event.key === 'Enter' || event.key === ' ') && !applied) { event.preventDefault(); props.onPick(entry) }
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
          borderRadius: token.borderRadius, border: `1px solid ${token.colorBorder}`,
          cursor: applied ? 'not-allowed' : 'pointer', opacity: applied ? 0.5 : 1,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {entry.serverName}
          </div>
          <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, wordBreak: 'break-all' }}>
            {entry.input.transport === 'streamable-http'
              ? entry.input.url ?? ''
              : [entry.input.command, ...(entry.input.args ?? [])].filter(Boolean).join(' ')}
          </div>
        </div>
        <Tag>{entry.input.transport}</Tag>
        {applied && <Tag color="default">{t('ext.mcp.alreadyApplied')}</Tag>}
      </div>
    )
  }

  return (
    <Modal
      open={props.open}
      title={t('ext.mcp.pickFromLib')}
      footer={null}
      onCancel={props.onCancel}
      width={520}
      destroyOnHidden
    >
      <LibraryPicker
        rows={visible}
        total={props.entries.length}
        query={query}
        onQuery={setQuery}
        page={page}
        onPage={setPage}
        // Name, transport, and the address a person recognises — the three things
        // someone types when looking for a server they half-remembers.
        fields={entry => [
          entry.serverName,
          entry.input.transport,
          entry.input.transport === 'streamable-http'
            ? entry.input.url
            : [entry.input.command, ...(entry.input.args ?? [])].join(' '),
        ]}
        keyOf={entry => entry.serverName}
        renderRow={row}
        empty={<EmptyState title={t('ext.mcp.libEmpty')} description={t('ext.mcp.libEmptyDesc')} />}
        searchPlaceholder={t('ext.mcp.searchPlaceholder')}
        toolbar={(
          <Checkbox checked={hideApplied} onChange={event => setHideApplied(event.target.checked)}>
            {t('ext.lib.hideDoneMcp')}
          </Checkbox>
        )}
      />
    </Modal>
  )
}

/**
 * Whether one library skill is blocked on a dsh: a copy is already there AND it
 * is current. A stale copy is actionable (reinstall), so it is not blocked.
 *
 * Shared by the row and the "hide up-to-date" toggle on purpose — a filter that
 * disagreed with the rows' own disabling would hide a row that can be clicked,
 * or leave one that cannot.
 */
function blockedOnDsh(row: SkillLibOverviewRow, dshId: string): boolean {
  const current = row.installs.find(install => install.dshId === dshId)
  return current?.installed === true && current.stale !== true
}

/**
 * Pick a library skill to install on one fixed dsh. Rows show the entry's
 * state on that dsh: not installed (install), stale (reinstall), or
 * up-to-date (blocked — drop the copy first).
 */
export function PickLibSkillModal(props: {
  open: boolean
  rows: SkillLibOverviewRow[]
  dshId: string
  busy: string | null
  onCancel: () => void
  onPick: (entry: SkillLibEntry, overwrite: boolean) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [hideDone, setHideDone] = useState(false)

  // A fresh search each time the dialog opens — see the MCP picker above.
  useEffect(() => {
    if (!props.open) return
    setQuery('')
    setPage(1)
    setHideDone(false)
  }, [props.open])
  useEffect(() => { setPage(1) }, [query, hideDone])

  // A blocked row only reports "drop the copy first", so on a library the dsh
  // already has, the installable rows are the ones worth paging through.
  const visible = hideDone ? props.rows.filter(item => !blockedOnDsh(item, props.dshId)) : props.rows

  const row = (item: SkillLibOverviewRow): JSX.Element => {
    const current = item.installs.find(install => install.dshId === props.dshId)
    const installed = current?.installed === true
    const stale = current?.stale === true
    const blocked = blockedOnDsh(item, props.dshId)
    return (
      <div
        role="button"
        tabIndex={blocked ? -1 : 0}
        aria-disabled={blocked}
        onClick={() => { if (!blocked && props.busy === null) props.onPick(item.entry, installed) }}
        onKeyDown={event => {
          if ((event.key === 'Enter' || event.key === ' ') && !blocked) { event.preventDefault(); props.onPick(item.entry, installed) }
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
          borderRadius: token.borderRadius, border: `1px solid ${token.colorBorder}`,
          cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.5 : 1,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.entry.name}
          </div>
          <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {item.entry.description}
          </div>
        </div>
        {blocked && <Tag color="success">{t('ext.skills.upToDateTag')}</Tag>}
        {stale && <Tag color="warning">{t('ext.skills.staleTag')}</Tag>}
      </div>
    )
  }

  return (
    <Modal
      open={props.open}
      title={t('ext.skills.pickFromLib')}
      footer={null}
      onCancel={props.onCancel}
      width={520}
      destroyOnHidden
    >
      <LibraryPicker
        rows={visible}
        total={props.rows.length}
        query={query}
        onQuery={setQuery}
        page={page}
        onPage={setPage}
        // The description is what someone recognises a skill by; `whenToUse` is
        // the phrase they remember typing into the prompt.
        fields={item => [item.entry.name, item.entry.description, item.entry.whenToUse]}
        keyOf={item => item.entry.name}
        renderRow={row}
        empty={<EmptyState title={t('ext.skills.libEmpty')} description={t('ext.skills.libEmptyDesc')} />}
        searchPlaceholder={t('ext.skills.searchPlaceholder')}
        toolbar={(
          <Checkbox checked={hideDone} onChange={event => setHideDone(event.target.checked)}>
            {t('ext.lib.hideDoneSkills')}
          </Checkbox>
        )}
      />
    </Modal>
  )
}

/**
 * The install modal's body: which dsh, whether to overwrite, and WHY the copy is
 * in the state it is in.
 *
 * Separate from the modal because a `Modal` renders through a portal — its content
 * does not exist in a server render, so "the reason is visible" could not be
 * asserted anywhere but in a browser. This part is presentational and pure, and
 * the state it renders comes from the one shared rule in `lib/skillInstallState`.
 */
export function InstallSkillFields(props: {
  scopes: DshScope[]
  dshId: string | undefined
  onPickDsh: (id: string) => void
  /** This entry's cell on the selected dsh, if there is one. */
  current: SkillLibInstall | undefined
  overwrite: boolean
  onOverwrite: (next: boolean) => void
}): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const state = props.current === undefined ? undefined : installCellState(props.current)
  const installed = props.current?.installed === true
  const hint = state === undefined || state === 'notInstalled'
    ? t('ext.skills.installHint')
    : state === 'stale'
      ? t('ext.skills.installStaleHint')
      : state === 'problem'
        ? t('ext.skills.installProblemHint')
        : t('ext.skills.installUpToDateHint')

  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      <div>
        <FieldLabel>{t('ext.target.dsh')}</FieldLabel>
        <Select
          style={{ width: '100%' }}
          showSearch
          optionFilterProp="label"
          value={props.dshId}
          onChange={props.onPickDsh}
          options={props.scopes.map(scope => ({ value: scope.id, label: scope.name }))}
        />
      </div>
      {installed && state !== 'problem' && (
        <Checkbox checked={props.overwrite} onChange={e => props.onOverwrite(e.target.checked)}>
          {t('ext.skills.overwrite')}
        </Checkbox>
      )}
      {props.current?.problem !== undefined && (
        <Alert
          type="error"
          showIcon
          title={t('ext.skills.installProblem', { reason: props.current.problem })}
          description={t('ext.skills.installProblemHint')}
        />
      )}
      <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>{hint}</div>
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        {t('ext.skills.installTargetHint')}
      </Typography.Text>
    </Space>
  )
}

/** Pick a dsh and install a library skill into its writable root. */
export function InstallSkillModal(props: {
  open: boolean
  entry: SkillLibEntry | null
  installs: SkillLibInstall[]
  scopes: DshScope[]
  busy: boolean
  onCancel: () => void
  onInstall: (dshId: string, overwrite: boolean) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [dshId, setDshId] = useState<string>()
  const [overwrite, setOverwrite] = useState(false)

  useEffect(() => {
    if (!props.open) return
    setDshId(prev => (prev !== undefined && props.scopes.some(s => s.id === prev)) ? prev : props.scopes[0]?.id)
    setOverwrite(false)
  }, [props.open, props.scopes])

  // The install state of the selected entry on the selected dsh decides whether
  // the copy is a plain install, needs an explicit overwrite, or cannot be read at
  // all — and the last one is not a reinstall problem, so the action says
  // "reinstall anyway" instead of pretending a plain install is the answer.
  const current = props.installs.find(install => install.dshId === dshId)
  const state = current === undefined ? undefined : installCellState(current)
  const installed = current?.installed === true
  // An up-to-date copy is only replaced after the explicit overwrite consent; a
  // stale one, an absent one, or an unreadable one installs straight away.
  const okDisabled = dshId === undefined
    || (state === 'upToDate' && !overwrite)

  return (
    <Modal
      open={props.open}
      title={t('ext.skills.installTitle', { name: props.entry?.name ?? '' })}
      okText={state === 'problem' ? t('ext.skills.reinstallAnyway') : t('ext.skills.install')}
      cancelText={t('common.cancel')}
      confirmLoading={props.busy}
      onOk={() => { if (dshId !== undefined) props.onInstall(dshId, installed) }}
      onCancel={props.onCancel}
      okButtonProps={{ disabled: okDisabled }}
      destroyOnHidden
    >
      {props.scopes.length === 0
        ? <EmptyState title={t('ext.target.noDsh')} />
        : (
          <InstallSkillFields
            scopes={props.scopes}
            dshId={dshId}
            onPickDsh={setDshId}
            current={current}
            overwrite={overwrite}
            onOverwrite={setOverwrite}
          />
          )}
    </Modal>
  )
}
