/**
 * Skills — the launcher-global LIBRARY view of the skills track.
 *
 * An entry is a `<name>/SKILL.md` bundle (plus its resource files) owned by
 * the launcher — nothing here is bound to a dsh. Installing copies the bundle
 * into a dsh's writable root, which is what dsh actually discovers, so a card
 * also shows where the skill is installed and whether those copies are stale
 * (the library has a newer SKILL.md). Zip import lands in the library.
 *
 * Layout mirrors the plugins section: a heading that carries the actions, then
 * a searchable / filterable card grid with local pagination.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Pagination, Segmented, Skeleton, Space, Typography, theme, message } from 'antd'
import { PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import EmptyState from '../components/EmptyState.tsx'
import Panel from '../components/Panel.tsx'
import SearchInput from '../components/SearchInput.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import Toolbar from '../components/Toolbar.tsx'
import SkillCard from './SkillCard.tsx'
import { SkillEditorModal, SkillNameModal } from './ExtensionsModals.tsx'
import { InstallSkillModal, type DshScope } from './LibraryModals.tsx'
import type { SkillLibEntry, SkillLibIssue, SkillLibOverviewRow } from '../../../shared/types.ts'

/** Cards per page (the grid paginates locally, like the plugin overview). */
const CARDS_PER_PAGE = 24

type Bucket = 'all' | 'installed' | 'notInstalled' | 'stale'

interface EditorState {
  open: boolean
  /** The name being edited, or `null` when creating. */
  previousName: string | null
  text: string
}

export default function SkillsView(): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [rows, setRows] = useState<SkillLibOverviewRow[] | null>(null)
  const [issues, setIssues] = useState<SkillLibIssue[]>([])
  const [scopes, setScopes] = useState<DshScope[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [nameModal, setNameModal] = useState(false)
  const [editor, setEditor] = useState<EditorState>({ open: false, previousName: null, text: '' })
  const [installEntry, setInstallEntry] = useState<SkillLibEntry | null>(null)

  // Repository filters + local pagination.
  const [search, setSearch] = useState('')
  const [bucket, setBucket] = useState<Bucket>('all')
  const [page, setPage] = useState(1)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const [overview, lib, options] = await Promise.all([
      window.api.ext.libSkillOverview(),
      window.api.ext.libSkillList(),
      window.api.plugins.installOptions(),
    ])
    setLoading(false)
    if (!overview.ok) { void message.error(apiErrorText(overview)); return }
    setRows(overview.value)
    if (lib.ok) setIssues(lib.value.issues)
    if (options.ok) setScopes(options.value)
  }, [])

  useEffect(() => { void load() }, [load])

  const create = async (name: string): Promise<void> => {
    setNameModal(false)
    const r = await window.api.ext.libSkillScaffold(name)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setEditor({ open: true, previousName: null, text: r.value })
  }

  const openEdit = async (entry: SkillLibEntry): Promise<void> => {
    setBusy(`edit:${entry.name}`)
    const r = await window.api.ext.libSkillRead(entry.name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setEditor({ open: true, previousName: entry.name, text: r.value.text })
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    const r = await window.api.ext.libSkillSave(editor.previousName, editor.text)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.skills.saved', { name: r.value.name }))
    setEditor({ open: false, previousName: null, text: '' })
    await load()
  }

  const remove = async (entry: SkillLibEntry): Promise<void> => {
    setBusy(`remove:${entry.name}`)
    const r = await window.api.ext.libSkillDelete(entry.name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.skills.deleted', { name: entry.name }))
    await load()
  }

  const importZip = async (): Promise<void> => {
    setBusy('import')
    const r = await window.api.ext.libSkillImportZip()
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    if (r.value === null) return // dialog cancelled — not an error
    void message.success(t('ext.skills.imported', { names: r.value.map(entry => entry.name).join(', ') }))
    await load()
  }

  const install = async (dshId: string, overwrite: boolean): Promise<void> => {
    if (installEntry === null) return
    setBusy('install')
    const r = await window.api.ext.libSkillInstall(installEntry.name, dshId, overwrite)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.skills.installed', { name: installEntry.name }))
    setInstallEntry(null)
    await load()
  }

  const entries = rows ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter(row => {
      const installedCount = row.installs.filter(install => install.installed).length
      const staleCount = row.installs.filter(install => install.installed && install.stale).length
      if (bucket === 'installed' && installedCount === 0) return false
      if (bucket === 'notInstalled' && installedCount > 0) return false
      if (bucket === 'stale' && staleCount === 0) return false
      if (q !== '') {
        const hay = [row.entry.name, row.entry.description, row.entry.whenToUse ?? ''].join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [entries, search, bucket])

  // Reset to the first page whenever the filter changes.
  useEffect(() => { setPage(1) }, [search, bucket])

  const lastPage = Math.max(1, Math.ceil(filtered.length / CARDS_PER_PAGE))
  const currentPage = Math.min(page, lastPage)
  const paged = filtered.slice((currentPage - 1) * CARDS_PER_PAGE, currentPage * CARDS_PER_PAGE)

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <SectionHeading
        title={t('ext.tab.skills')}
        description={(
          <span>
            {rows !== null && (
              <>
                {t('ext.skills.libSummary', { total: entries.length })}
                {issues.length > 0 ? ` · ${t('ext.skills.summaryIssues', { count: issues.length })}` : ''}
                {' · '}
              </>
            )}
            {t('ext.skills.libHint')}
          </span>
        )}
        extra={(
          <Space size={8} wrap>
            <Button
              size="small"
              icon={<UploadOutlined />}
              loading={busy === 'import'}
              onClick={() => void importZip()}
            >
              {t('ext.skills.import')}
            </Button>
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              {t('common.refresh')}
            </Button>
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setNameModal(true)}>
              {t('ext.skills.add')}
            </Button>
          </Space>
        )}
      />

      {issues.map((issue, i) => (
        <Alert
          key={i}
          type="warning"
          showIcon
          title={t('ext.skills.issueTitle')}
          description={(
            <div>
              <Typography.Text code style={{ fontSize: token.fontSizeSM }}>{issue.path}</Typography.Text>
              <div style={{ marginTop: 2 }}>{issue.reason}</div>
            </div>
          )}
        />
      ))}

      <Panel pad={false}>
        <Toolbar>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t('ext.skills.searchPlaceholder')}
            ariaLabel={t('ext.skills.searchPlaceholder')}
          />
          <Segmented
            value={bucket}
            onChange={value => setBucket(value as Bucket)}
            options={[
              { value: 'all', label: t('ext.skills.bucket.all') },
              { value: 'installed', label: t('ext.skills.bucket.installed') },
              { value: 'notInstalled', label: t('ext.skills.bucket.notInstalled') },
              { value: 'stale', label: t('ext.skills.bucket.stale') },
            ]}
          />
        </Toolbar>

        <div style={{ padding: token.padding }}>
          {loading && rows === null ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: token.padding }}>
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} style={{ border: `1px solid ${token.colorBorder}`, borderRadius: token.borderRadiusLG, padding: token.padding }}>
                  <Skeleton active title={false} paragraph={{ rows: 3 }} />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              title={entries.length === 0 ? t('ext.skills.libEmpty') : t('common.noData')}
              description={entries.length === 0 ? t('ext.skills.libEmptyDesc') : undefined}
              action={entries.length === 0 && bucket === 'all' && search.trim() === '' ? (
                <Space size={8}>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => setNameModal(true)}>
                    {t('ext.skills.add')}
                  </Button>
                  <Button icon={<UploadOutlined />} onClick={() => void importZip()}>
                    {t('ext.skills.import')}
                  </Button>
                </Space>
              ) : undefined}
            />
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: token.padding }}>
                {paged.map(row => (
                  <SkillCard
                    key={row.entry.name}
                    entry={row.entry}
                    installs={row.installs}
                    editBusy={busy === `edit:${row.entry.name}`}
                    onOpen={() => void openEdit(row.entry)}
                    onInstall={() => setInstallEntry(row.entry)}
                    onDelete={() => void remove(row.entry)}
                  />
                ))}
              </div>
              {lastPage > 1 && (
                <Pagination
                  style={{ textAlign: 'center', marginTop: token.padding }}
                  current={currentPage}
                  pageSize={CARDS_PER_PAGE}
                  total={filtered.length}
                  showSizeChanger={false}
                  onChange={setPage}
                />
              )}
            </>
          )}
        </div>
      </Panel>

      <SkillNameModal
        open={nameModal}
        onCancel={() => setNameModal(false)}
        onSubmit={name => void create(name)}
      />

      <SkillEditorModal
        open={editor.open}
        previousName={editor.previousName}
        text={editor.text}
        saving={busy === 'save'}
        onChange={text => setEditor(prev => ({ ...prev, text }))}
        onCancel={() => setEditor({ open: false, previousName: null, text: '' })}
        onSubmit={() => void save()}
      />

      <InstallSkillModal
        open={installEntry !== null}
        entry={installEntry}
        installs={installEntry !== null
          ? (rows?.find(row => row.entry.name === installEntry.name)?.installs ?? [])
          : []}
        scopes={scopes}
        busy={busy === 'install'}
        onCancel={() => setInstallEntry(null)}
        onInstall={(dshId, overwrite) => void install(dshId, overwrite)}
      />
    </Space>
  )
}
