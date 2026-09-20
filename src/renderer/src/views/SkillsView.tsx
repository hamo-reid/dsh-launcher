/**
 * Skills — the repository view of the skills track (dsh-scoped, not
 * per-profile).
 *
 * The listing mirrors what dsh's `skill-filesystem` provider discovers: every
 * root in rank order, with the writable user-dsh root (`<dshHome>/skills`) as
 * the only place the launcher creates, edits, or deletes entries. A delete
 * moves the entry to the OS recycle bin; files dsh would silently ignore are
 * surfaced as issues instead.
 *
 * Layout mirrors the plugins section: a heading that carries the dsh picker
 * and actions, then a searchable / filterable card grid with local pagination.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Pagination, Segmented, Select, Skeleton, Space, Typography, theme, message } from 'antd'
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
import type { SkillEntry, SkillListing } from '../../../shared/types.ts'

/** Cards per page (the grid paginates locally, like the plugin overview). */
const CARDS_PER_PAGE = 24

type Bucket = 'all' | 'editable' | 'readonly'

/** One dsh and the profiles it holds, for the target picker. */
interface DshScope { id: string; name: string; profiles: string[] }

interface EditorState {
  open: boolean
  /** The name being edited, or `null` when creating. */
  previousName: string | null
  text: string
}

export default function SkillsView(): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  // Target context — the view owns its dsh picker.
  const [scopes, setScopes] = useState<DshScope[]>([])
  const [dshId, setDshId] = useState<string>()

  const [listing, setListing] = useState<SkillListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [nameModal, setNameModal] = useState(false)
  const [editor, setEditor] = useState<EditorState>({ open: false, previousName: null, text: '' })

  // Repository filters + local pagination.
  const [search, setSearch] = useState('')
  const [bucket, setBucket] = useState<Bucket>('all')
  const [page, setPage] = useState(1)

  useEffect(() => {
    void (async () => {
      const r = await window.api.plugins.installOptions()
      if (!r.ok) return
      setScopes(r.value)
      setDshId(prev => (prev !== undefined && r.value.some(s => s.id === prev)) ? prev : r.value[0]?.id)
    })()
  }, [])

  const load = useCallback(async (): Promise<void> => {
    if (dshId === undefined) { setListing(null); return }
    setLoading(true)
    const r = await window.api.ext.skillList(dshId)
    setLoading(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setListing(r.value)
  }, [dshId])

  useEffect(() => { void load() }, [load])

  const create = async (name: string): Promise<void> => {
    if (dshId === undefined) return
    setNameModal(false)
    const r = await window.api.ext.skillScaffold(name)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setEditor({ open: true, previousName: null, text: r.value })
  }

  const openEdit = async (entry: SkillEntry): Promise<void> => {
    if (dshId === undefined) return
    setBusy(`edit:${entry.name}`)
    const r = await window.api.ext.skillRead(dshId, entry.name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setEditor({ open: true, previousName: entry.name, text: r.value.text })
  }

  const save = async (): Promise<void> => {
    if (dshId === undefined) return
    setBusy('save')
    const r = await window.api.ext.skillSave(dshId, editor.previousName, editor.text)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.skills.saved', { name: r.value.name }))
    setEditor({ open: false, previousName: null, text: '' })
    await load()
  }

  const remove = async (entry: SkillEntry): Promise<void> => {
    if (dshId === undefined) return
    setBusy(`remove:${entry.name}`)
    const r = await window.api.ext.skillDelete(dshId, entry.name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.skills.deleted', { name: entry.name }))
    await load()
  }

  const importZip = async (): Promise<void> => {
    if (dshId === undefined) return
    setBusy('import')
    const r = await window.api.ext.skillImportZip(dshId)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    if (r.value === null) return // dialog cancelled — not an error
    void message.success(t('ext.skills.imported', { names: r.value.map(entry => entry.name).join(', ') }))
    await load()
  }

  const skills = listing?.skills ?? []
  const issues = listing?.issues ?? []
  const roots = listing?.roots ?? []
  const writable = roots.find(root => root.writable)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return skills.filter(entry => {
      if (bucket === 'editable' && !entry.editable) return false
      if (bucket === 'readonly' && entry.editable) return false
      if (q !== '') {
        const hay = [entry.name, entry.description, entry.whenToUse ?? ''].join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [skills, search, bucket])

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
            {listing !== null && (
              <>
                {t('ext.skills.summaryTotal', { total: skills.length })}
                {issues.length > 0 ? ` · ${t('ext.skills.summaryIssues', { count: issues.length })}` : ''}
                {' · '}
              </>
            )}
            {writable !== undefined && (
              <>
                {t('ext.skills.writableRoot')}:{' '}
                <Typography.Text code style={{ fontSize: token.fontSizeSM }}>{writable.path}</Typography.Text>
              </>
            )}
          </span>
        )}
        extra={(
          <Space size={8} wrap>
            <Select
              size="small"
              style={{ minWidth: 170 }}
              showSearch
              optionFilterProp="label"
              value={dshId}
              placeholder={t('ext.target.dsh')}
              onChange={id => setDshId(id)}
              options={scopes.map(scope => ({ value: scope.id, label: scope.name }))}
            />
            <Button
              size="small"
              icon={<UploadOutlined />}
              loading={busy === 'import'}
              disabled={dshId === undefined}
              onClick={() => void importZip()}
            >
              {t('ext.skills.import')}
            </Button>
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              {t('common.refresh')}
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              disabled={dshId === undefined}
              onClick={() => setNameModal(true)}
            >
              {t('ext.skills.add')}
            </Button>
          </Space>
        )}
      />

      {dshId === undefined ? (
        <EmptyState title={t('ext.target.noDsh')} />
      ) : (
        <>
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
                  { value: 'editable', label: t('ext.skills.bucket.editable') },
                  { value: 'readonly', label: t('ext.skills.bucket.readonly') },
                ]}
              />
            </Toolbar>

            <div style={{ padding: token.padding }}>
              {loading && listing === null ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: token.padding }}>
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} style={{ border: `1px solid ${token.colorBorder}`, borderRadius: token.borderRadiusLG, padding: token.padding }}>
                      <Skeleton active title={false} paragraph={{ rows: 3 }} />
                    </div>
                  ))}
                </div>
              ) : skills.length === 0 && issues.length === 0 ? (
                <EmptyState
                  title={t('ext.skills.empty')}
                  description={t('ext.skills.emptyDesc')}
                  action={(
                    <Space size={8}>
                      <Button type="primary" icon={<PlusOutlined />} onClick={() => setNameModal(true)}>
                        {t('ext.skills.add')}
                      </Button>
                      <Button icon={<UploadOutlined />} onClick={() => void importZip()}>
                        {t('ext.skills.import')}
                      </Button>
                    </Space>
                  )}
                />
              ) : filtered.length === 0 ? (
                <EmptyState title={t('common.noData')} />
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: token.padding }}>
                    {paged.map(entry => (
                      <SkillCard
                        key={`${entry.source}:${entry.path}`}
                        entry={entry}
                        editBusy={busy === `edit:${entry.name}`}
                        onOpen={() => void openEdit(entry)}
                        onDelete={() => void remove(entry)}
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
        </>
      )}

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
    </Space>
  )
}
