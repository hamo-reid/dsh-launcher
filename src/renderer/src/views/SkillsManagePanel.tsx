/**
 * Skills installed on ONE dsh — the dsh side of the extensions model. dsh
 * discovers skills from filesystem roots, so this panel lists what the dsh
 * holds, creates and edits the ones living in its writable root, drops entries
 * into the recycle bin, imports a zip, and installs from the launcher-global
 * library. A copy that drifted from its library entry is flagged for reinstall.
 *
 * Three presentation decisions, all of them about density:
 *
 * - The catalog is a GRID OF CARDS (one skill, one unit with its own actions)
 *   rather than rows between dividers.
 * - The roots dsh actually scans sit above it as one quiet block: they answer
 *   "is the root I expected there?" and are read once.
 * - The PANEL is the drop target, so importing a zip costs no layout at all —
 *   the overlay only exists while the gesture does (`DropOverlay`).
 *
 * The PROFILE is the panel's scope, not a filter: a preset contributes skill roots
 * only inside a profile's composition, so a listing without one is the
 * machine-level answer — and it says so, rather than quietly omitting those rows.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Select, Skeleton, Space, Tag, Tooltip, Typography, theme, message } from 'antd'
import { PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import {
  canReaskProfile, profileScope, scopeNames, scopeProfile, type ProfileScope,
} from '../lib/profileScope.ts'
import { skillRootTags } from '../lib/skillSource.ts'
import EmptyState from '../components/EmptyState.tsx'
import Panel from '../components/Panel.tsx'
import { DropOverlay, useFileDrop } from '../components/DropZone.tsx'
import DshSkillCard from './DshSkillCard.tsx'
import { SkillEditorModal, SkillNameModal } from './ExtensionsModals.tsx'
import { PickLibSkillModal } from './LibraryModals.tsx'
import type {
  SkillEntry, SkillLibInstall, SkillLibOverviewRow, SkillListing, SkillRootInfo,
} from '../../../shared/types.ts'

const MONO: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  wordBreak: 'break-all',
}

/** The editor modal's state: a name being edited, or `null` when creating. */
interface EditorState {
  open: boolean
  previousName: string | null
  text: string
}

const CLOSED_EDITOR: EditorState = { open: false, previousName: null, text: '' }

export default function SkillsManagePanel(p: { dshId: string }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [listing, setListing] = useState<SkillListing | null>(null)
  const [overview, setOverview] = useState<SkillLibOverviewRow[]>([])
  // Why the last listing could not be read. Kept apart from `listing`: a refused
  // read is not an empty dsh, and rendering it as "no skills yet" tells the user
  // something false about their dsh (the reason is what they need).
  const [error, setError] = useState<string | null>(null)
  // The profile names AND the choice among them are one value, tagged with the dsh
  // they were read from. This panel keeps its state across a dsh switch (the page
  // renders it without a `key`), so an untagged name would outlive the dsh it came
  // from and be sent to the next one — a refusal core has to make, since a silently
  // dropped profile reads as "this dsh contributes nothing".
  const [scope, setScope] = useState<ProfileScope | null>(null)
  // True from the first frame: the panel reads on mount, and a skeleton of the
  // shape that is coming beats an empty box that then fills in (or, worse, an
  // "no skills" line that is not true yet).
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [installOpen, setInstallOpen] = useState(false)
  const [nameOpen, setNameOpen] = useState(false)
  const [editor, setEditor] = useState<EditorState>(CLOSED_EDITOR)
  // Two in-flight sequences, each guarded: a response may only land for the
  // selection it was asked about (a late listing must not appear under the next
  // dsh's heading, and a late name list must not re-tag the scope as its own).
  const profileRead = useRef(0)
  const listingRead = useRef(0)

  /** Read THIS dsh's profile names into the scope, keeping the remembered name,
   * and return them — a refused listing needs to know whether asking again is
   * worth it. A failed read writes nothing, so the scope keeps its previous tag
   * and the derived profile stays `undefined` rather than pointing at names this
   * dsh never confirmed. `null` means the read itself did not answer. */
  const readProfiles = useCallback(async (): Promise<readonly string[] | null> => {
    const mine = profileRead.current + 1
    profileRead.current = mine
    const r = await window.api.dsh.profiles(p.dshId)
    if (profileRead.current !== mine) return null
    if (!r.ok) { void message.error(apiErrorText(r)); return null }
    const names = r.value.map(entry => entry.name)
    setScope(prev => profileScope(p.dshId, names, prev?.chosen))
    return names
  }, [p.dshId])

  useEffect(() => { void readProfiles() }, [readProfiles])

  // `undefined` stays reachable — the select can be cleared — and means the
  // machine-level view, which the hint below states rather than hides.
  const profile = scopeProfile(scope, p.dshId)
  const names = scopeNames(scope, p.dshId)

  const load = useCallback(async (): Promise<void> => {
    const mine = listingRead.current + 1
    listingRead.current = mine
    setLoading(true)
    const [list, lib] = await Promise.all([
      window.api.ext.skillList(p.dshId, profile),
      window.api.ext.libSkillOverview(),
    ])
    if (listingRead.current !== mine) return
    setLoading(false)
    if (!list.ok) {
      // A name this dsh no longer has — its home moved, or the profile was deleted
      // or renamed while this page stayed open: re-read the list and ask again
      // through the reconciled choice, instead of reporting a refusal the page
      // itself caused. A name still listed means the refusal is real.
      if (profile !== undefined) {
        const fresh = await readProfiles()
        if (fresh !== null && canReaskProfile(profile, fresh)) return
      }
      void message.error(apiErrorText(list))
      setError(apiErrorText(list))
      return
    }
    setError(null)
    setListing(list.value)
    if (lib.ok) setOverview(lib.value)
  }, [p.dshId, profile, readProfiles])

  useEffect(() => { void load() }, [load])

  // A listing belongs to ONE dsh: switching must not leave the previous dsh's
  // skills on screen while the next one loads — the same rule its requests follow.
  // (A profile switch within the dsh keeps the cards: they are still this dsh's.)
  useEffect(() => {
    setListing(null)
    setError(null)
  }, [p.dshId])

  /** This skill's cell on THIS dsh: the library's verdict, or the reason the copy
   * (or the library entry) cannot be read at all. */
  const cellFor = (name: string): SkillLibInstall | undefined =>
    overview.find(row => row.entry.name === name)?.installs.find(install => install.dshId === p.dshId)

  const remove = async (entry: SkillEntry): Promise<void> => {
    setBusy(`remove:${entry.name}`)
    const r = await window.api.ext.skillDelete(p.dshId, entry.name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.skills.deleted', { name: entry.name }))
    await load()
  }

  const reinstall = async (entry: SkillEntry): Promise<void> => {
    setBusy(`reinstall:${entry.name}`)
    const r = await window.api.ext.libSkillInstall(entry.name, p.dshId, true)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.skills.installed', { name: entry.name }))
    await load()
  }

  const install = async (name: string, overwrite: boolean): Promise<void> => {
    setInstallOpen(false)
    setBusy('install')
    const r = await window.api.ext.libSkillInstall(name, p.dshId, overwrite)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.skills.installed', { name }))
    await load()
  }

  /** A new skill starts from the same scaffold the writer renders, so an
   * untouched save is already a valid SKILL.md. */
  const create = async (name: string): Promise<void> => {
    setNameOpen(false)
    const r = await window.api.ext.skillScaffold(name)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setEditor({ open: true, previousName: null, text: r.value })
  }

  const openEdit = async (entry: SkillEntry): Promise<void> => {
    setBusy(`edit:${entry.name}`)
    const r = await window.api.ext.skillRead(p.dshId, entry.name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setEditor({ open: true, previousName: entry.name, text: r.value })
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    const r = await window.api.ext.skillSave(p.dshId, editor.previousName, editor.text)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.skills.saved', { name: r.value.name }))
    setEditor(CLOSED_EDITOR)
    await load()
  }

  const importZip = async (zipPath?: string): Promise<void> => {
    setBusy('import')
    const r = await window.api.ext.skillImportZip(p.dshId, zipPath)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    if (r.value === null) return // dialog cancelled — not an error
    void message.success(t('ext.skills.imported', { names: r.value.map(entry => entry.name).join(', ') }))
    await load()
  }

  const dropFiles = (files: File[]): void => {
    const file = files[0]
    if (file === undefined) return
    if (files.length > 1) void message.warning(t('ext.skills.dropOneAtATime'))
    // A skill zip is text-sized; refuse anything absurd before touching IPC.
    if (file.size > 64 * 1024 * 1024) { void message.warning(t('ext.skills.dropTooLarge')); return }
    // Resolve synchronously, before any await — the File's on-disk backing is only
    // reliable inside the drop event's context.
    const path = window.api.ext.filePath(file)
    if (path === '') { void message.error(t('ext.skills.dropNoPath')); return }
    void importZip(path)
  }

  // The whole panel is the drop target: the gesture needs no block of its own, so
  // nothing here does anything but hand the drop to `dropFiles`.
  const drop = useFileDrop({
    accept: ['.zip'],
    onDrop: files => dropFiles(files),
    onReject: () => { void message.warning(t('ext.skills.dropWrongType')) },
    disabled: busy === 'import',
  })

  /** Which of one card's actions is running, from the panel's single busy key. */
  const busyOf = (name: string): 'edit' | 'reinstall' | null => {
    if (busy === `edit:${name}`) return 'edit'
    if (busy === `reinstall:${name}`) return 'reinstall'
    return null
  }

  const skills = listing?.skills ?? []
  const issues = listing?.issues ?? []
  const roots = listing?.roots ?? []
  const actionRow = (
    <Space size={8} wrap>
      <Select
        size="small"
        style={{ minWidth: 150 }}
        value={profile}
        placeholder={t('ext.skills.profile')}
        aria-label={t('ext.skills.profile')}
        allowClear
        disabled={names.length === 0}
        options={names.map(name => ({ value: name, label: name }))}
        onChange={(value?: string) => setScope(prev => (prev === null ? null : { ...prev, chosen: value }))}
      />
      <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setNameOpen(true)}>
        {t('ext.skills.add')}
      </Button>
      <Button size="small" icon={<UploadOutlined />} loading={busy === 'import'} onClick={() => void importZip()}>
        {t('ext.skills.import')}
      </Button>
      <Button size="small" onClick={() => setInstallOpen(true)}>
        {t('ext.skills.installFromLib')}
      </Button>
      <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
        {t('common.refresh')}
      </Button>
    </Space>
  )

  return (
    <>
      <div
        {...drop.handlers}
        style={{ position: 'relative', width: '100%', borderRadius: token.borderRadiusLG }}
      >
        <Panel title={t('dsh.skills')} extra={actionRow}>
          <Space direction="vertical" size={token.padding} style={{ width: '100%' }}>
            {profile === undefined && (
              <Alert
                type="info"
                showIcon
                title={t('ext.skills.profileNoneTitle')}
                description={t('ext.skills.profileNoneDesc')}
              />
            )}
            {loading && listing === null
              ? <ListingSkeleton />
              : (
                <>
                  {roots.length > 0 && <RootsBlock roots={roots} />}
                  {issues.map((issue, i) => (
                    <Alert
                      key={i}
                      type="warning"
                      showIcon
                      title={t('ext.skills.issueTitle')}
                      description={(
                        <div>
                          <span style={{ ...MONO, fontSize: token.fontSizeSM }}>{issue.path}</span>
                          <div style={{ marginTop: 2 }}>{issue.reason}</div>
                        </div>
                      )}
                    />
                  ))}
                  {error !== null && (
                    <Alert
                      type="error"
                      showIcon
                      title={t('ext.skills.loadFailed')}
                      description={error}
                    />
                  )}
                  {error === null && (skills.length === 0
                    ? (
                      <EmptyState
                        title={t('dsh.skillsEmpty')}
                        description={t('ext.skills.emptyDescDsh')}
                      />
                    )
                    : (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: token.padding }}>
                        {skills.map(entry => (
                          <DshSkillCard
                            key={`${entry.source}:${entry.path}`}
                            entry={entry}
                            cell={cellFor(entry.name)}
                            busy={busyOf(entry.name)}
                            onEdit={() => void openEdit(entry)}
                            onReinstall={() => void reinstall(entry)}
                            onDelete={() => void remove(entry)}
                          />
                        ))}
                      </div>
                    ))}
                </>
              )}
          </Space>
        </Panel>
        {/* The import gesture covers the whole panel for as long as it lasts — over
            it while a zip is dragged, and while the import runs. */}
        <DropOverlay
          active={drop.dragging || busy === 'import'}
          busy={busy === 'import'}
          hint={t('ext.skills.dropHint')}
          subHint={t('ext.skills.dropSubHintDsh')}
        />
      </div>
      <PickLibSkillModal
        open={installOpen}
        rows={overview}
        dshId={p.dshId}
        busy={busy === 'install' ? 'install' : null}
        onCancel={() => setInstallOpen(false)}
        onPick={(entry, overwrite) => void install(entry.name, overwrite)}
      />
      <SkillNameModal
        open={nameOpen}
        onCancel={() => setNameOpen(false)}
        onSubmit={name => void create(name)}
      />
      <SkillEditorModal
        open={editor.open}
        previousName={editor.previousName}
        text={editor.text}
        saving={busy === 'save'}
        onChange={text => setEditor(prev => ({ ...prev, text }))}
        onCancel={() => setEditor(CLOSED_EDITOR)}
        onSubmit={() => void save()}
      />
    </>
  )
}

/** The panel's loading state, shaped like what is coming: a roots line and a row of
 * cards. A skeleton of the right size keeps the page from jumping when the answer
 * lands, which is the whole reason for having one (docs/ui-guidelines.md §4). */
function ListingSkeleton(): JSX.Element {
  const { token } = theme.useToken()
  return (
    <>
      <Skeleton active title={false} paragraph={{ rows: 1 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: token.padding }}>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} style={{ border: `1px solid ${token.colorBorder}`, borderRadius: token.borderRadiusLG, padding: token.padding }}>
            <Skeleton active title={false} paragraph={{ rows: 3 }} />
          </div>
        ))}
      </div>
    </>
  )
}

/** The roots dsh actually scans, as one quiet block above the catalog.
 *
 * These paths are long and mostly read once ("is the root I expected in the list?"),
 * so each stays on ONE line with the full value on hover and a copy control beside
 * it — the treatment the presets page gives its source paths. Each row's tags come
 * from {@link skillRootTags}, which is where the one-tag-per-fact rule lives.
 *
 * Exported for its own render assertion: the panel's own listing arrives through an
 * effect, which a server render never runs (docs/TESTING.md §4). */
export function RootsBlock(props: { roots: SkillRootInfo[] }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  return (
    <div
      style={{
        background: token.colorFillQuaternary,
        border: `1px solid ${token.colorSplit}`,
        borderRadius: token.borderRadiusLG,
        padding: `${token.paddingSM}px ${token.padding}px`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>
          {t('ext.skills.rootsLabel')}
        </span>
        <span style={{ fontSize: token.fontSizeSM, color: token.colorTextTertiary }}>{props.roots.length}</span>
      </div>
      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {props.roots.map(root => (
          <div key={root.root} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {skillRootTags(root).map(tag => (
              <Tag key={tag.key} color={tag.colour} style={{ marginInlineEnd: 0 }}>
                {t(tag.key, tag.params)}
              </Tag>
            ))}
            <Tooltip title={root.path}>
              <span
                style={{
                  ...MONO,
                  flex: 1,
                  minWidth: 0,
                  color: token.colorTextTertiary,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {root.path}
              </span>
            </Tooltip>
            <Typography.Text copyable={{ text: root.path }} style={{ fontSize: token.fontSizeSM }} />
          </div>
        ))}
      </div>
    </div>
  )
}
