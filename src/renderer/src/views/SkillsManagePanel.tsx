/**
 * Skills installed on ONE dsh — the dsh side of the extensions model. dsh
 * discovers skills from filesystem roots, so this panel lists what the dsh
 * holds (rank order, read-only roots tagged), creates and edits the ones living
 * in its writable root, drops entries into the recycle bin, imports a zip, and
 * installs from the launcher-global library. A copy that drifted from its library
 * entry is flagged for reinstall.
 *
 * The PROFILE is the panel's scope, not a filter: a preset contributes skill roots
 * only inside a profile's composition, so a listing without one is the
 * machine-level answer — and it says so, rather than quietly omitting those rows.
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Empty, Select, Space, Tag, Tooltip, theme, message } from 'antd'
import { PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import { nextProfileChoice } from '../lib/profileScope.ts'
import { installCellColour, installCellState } from '../lib/skillInstallState.ts'
import Panel from '../components/Panel.tsx'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
import DropZone, { useFileDrop } from '../components/DropZone.tsx'
import { SkillEditorModal, SkillNameModal } from './ExtensionsModals.tsx'
import { PickLibSkillModal } from './LibraryModals.tsx'
import type {
  SkillEntry, SkillLibInstall, SkillLibOverviewRow, SkillListing,
} from '../../../shared/types.ts'

/** Tag colour per root origin (mirrors the dsh-side listing). */
const SOURCE_COLOUR: Record<SkillEntry['source'], string> = {
  'user-dsh': 'blue',
  'user-agents': 'purple',
  custom: 'orange',
  bundled: 'default',
  preset: 'cyan',
}

/** Source label key suffix (`ext.skills.source.<suffix>`). */
const SOURCE_KEY: Record<SkillEntry['source'], 'userDsh' | 'userAgents' | 'custom' | 'bundled' | 'preset'> = {
  'user-dsh': 'userDsh',
  'user-agents': 'userAgents',
  custom: 'custom',
  bundled: 'bundled',
  preset: 'preset',
}

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
  const [profiles, setProfiles] = useState<string[]>([])
  const [profile, setProfile] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [installOpen, setInstallOpen] = useState(false)
  const [nameOpen, setNameOpen] = useState(false)
  const [editor, setEditor] = useState<EditorState>(CLOSED_EDITOR)

  // The profile list follows the dsh; the current choice survives a refresh while
  // it still exists, and falls back to the first profile otherwise. `undefined`
  // stays reachable — the select can be cleared — and means the machine-level
  // view, which the hint below states rather than hides.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const r = await window.api.dsh.profiles(p.dshId)
      if (cancelled) return
      if (!r.ok) { void message.error(apiErrorText(r)); return }
      const names = r.value.map(entry => entry.name)
      setProfiles(names)
      setProfile(prev => nextProfileChoice(prev, names))
    })()
    return () => { cancelled = true }
  }, [p.dshId])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const [list, lib] = await Promise.all([
      window.api.ext.skillList(p.dshId, profile),
      window.api.ext.libSkillOverview(),
    ])
    setLoading(false)
    if (!list.ok) { void message.error(apiErrorText(list)); return }
    setListing(list.value)
    if (lib.ok) setOverview(lib.value)
  }, [p.dshId, profile])

  useEffect(() => { void load() }, [load])

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

  // The whole panel accepts drops; the DropZone block is purely visual and drops
  // on it bubble up here, so one drop always imports once.
  const drop = useFileDrop({
    accept: ['.zip'],
    onDrop: files => dropFiles(files),
    onReject: () => { void message.warning(t('ext.skills.dropWrongType')) },
    disabled: busy === 'import',
  })

  const skills = listing?.skills ?? []
  const issues = listing?.issues ?? []
  const actionRow = (
    <Space size={8} wrap>
      <Select
        size="small"
        style={{ minWidth: 150 }}
        value={profile}
        placeholder={t('ext.skills.profile')}
        aria-label={t('ext.skills.profile')}
        allowClear
        disabled={profiles.length === 0}
        options={profiles.map(name => ({ value: name, label: name }))}
        onChange={(value?: string) => setProfile(value)}
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
        style={{
          width: '100%',
          borderRadius: token.borderRadiusLG,
          // Highlight with an outline (not a background): the Panel is opaque and
          // would cover anything painted behind it.
          outline: drop.dragging ? `2px dashed ${token.colorPrimary}` : undefined,
          outlineOffset: -2,
        }}
      >
        <Panel title={t('dsh.skills')} extra={actionRow}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {profile === undefined && (
              <Alert
                type="info"
                showIcon
                title={t('ext.skills.profileNoneTitle')}
                description={t('ext.skills.profileNoneDesc')}
              />
            )}
            {listing !== null && (
              <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
                <div>{`${t('ext.skills.rootsLabel')} (${listing.roots.length})`}</div>
                {listing.roots.map(root => (
                  <div key={root.root} style={{ marginTop: 2 }}>
                    <Tag color={SOURCE_COLOUR[root.source]} style={{ marginInlineEnd: 6 }}>
                      {t(`ext.skills.source.${SOURCE_KEY[root.source]}`)}
                    </Tag>
                    {root.runtime === true
                      ? (
                        <>
                          <Tag style={{ marginInlineEnd: 6 }}>{t('ext.skills.rootRuntime')}</Tag>
                          <span style={MONO}>{root.path}</span>
                        </>
                      )
                      : (
                        <>
                          {root.source === 'preset' && (
                            <Tag color="cyan" style={{ marginInlineEnd: 6 }}>
                              {t('ext.skills.rootFromPreset', { owner: root.root.replace(/^preset:/, '') })}
                            </Tag>
                          )}
                          <span style={MONO}>{root.path}</span>
                        </>
                      )}
                  </div>
                ))}
              </div>
            )}
            {issues.map((issue, i) => (
              <Alert
                key={i}
                type="warning"
                showIcon
                title={t('ext.skills.issueTitle')}
                description={(
                  <div>
                    <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: token.fontSizeSM }}>{issue.path}</span>
                    <div style={{ marginTop: 2 }}>{issue.reason}</div>
                  </div>
                )}
              />
            ))}
            {skills.length === 0 && !loading && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('dsh.skillsEmpty')} />
            )}
            {skills.map(entry => {
              const cell = cellFor(entry.name)
              const state = cell === undefined ? undefined : installCellState(cell)
              const stale = state === 'stale'
              const actions: MenuAction[] = [
                ...(entry.editable ? [{ key: 'edit', label: t('common.edit') } as MenuAction] : []),
                ...(stale || state === 'problem' ? [{ key: 'reinstall', label: t('ext.skills.reinstall') } as MenuAction] : []),
                ...(entry.editable
                  ? [{ key: 'delete', label: t('common.delete'), danger: true, confirmText: t('ext.skills.deleteConfirm', { name: entry.name }) } as MenuAction]
                  : []),
              ]
              return (
                <div key={`${entry.source}:${entry.path}`} style={{ borderBottom: `1px solid ${token.colorSplit}`, paddingBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span title={entry.name} style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.name}
                    </span>
                    <Tag color={SOURCE_COLOUR[entry.source]}>{t(`ext.skills.source.${SOURCE_KEY[entry.source]}`)}</Tag>
                    {state === 'problem'
                      ? (
                        <Tooltip title={cell?.problem}>
                          <Tag color={installCellColour('problem')}>{t('ext.skills.problemTag', { count: 1 })}</Tag>
                        </Tooltip>
                        )
                      : stale && <Tag color={installCellColour('stale')}>{t('ext.skills.staleTag')}</Tag>}
                    {actions.length > 0 && (
                      <ConfirmMenu
                        actions={actions}
                        onAction={key => {
                          if (key === 'edit') void openEdit(entry)
                          else if (key === 'delete') void remove(entry)
                          else if (key === 'reinstall') void reinstall(entry)
                        }}
                      />
                    )}
                  </div>
                  <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {entry.description}
                  </div>
                </div>
              )
            })}
            {/* Only the writable root takes a new skill, so the affordance carries
                its own explanation rather than appearing to accept anything. */}
            <DropZone
              dragging={drop.dragging}
              busy={busy === 'import'}
              onPick={() => void importZip()}
              subHint={t('ext.skills.dropSubHintDsh')}
            />
          </Space>
        </Panel>
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
