/**
 * MCP servers — the launcher-global LIBRARY view of the MCP track.
 *
 * An entry is a definition; nothing here is bound to a dsh or a profile.
 * Applying an entry materializes a full row into a patch layer (dsh only reads
 * configuration from patch files), so a card also shows where the entry is
 * applied and whether those copies have drifted — one click rewrites them from
 * the library. Launch secrets stay in the encrypted launcher store and are
 * managed here too.
 *
 * Layout mirrors the plugins section: a heading that carries the actions, then
 * a searchable / filterable card grid with local pagination.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Pagination, Segmented, Skeleton, Space, theme, message } from 'antd'
import { KeyOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import EmptyState from '../components/EmptyState.tsx'
import Panel from '../components/Panel.tsx'
import SearchInput from '../components/SearchInput.tsx'
import SectionHeading from '../components/SectionHeading.tsx'
import Toolbar from '../components/Toolbar.tsx'
import McpCard from './McpCard.tsx'
import McpServerModal, { McpSecretModal, SecretsManageModal } from './ExtensionsModals.tsx'
import { ApplyMcpModal, type DshScope } from './LibraryModals.tsx'
import type { McpApplyTarget, McpLibEntry, McpLibOverviewRow, McpServerInput } from '../../../shared/types.ts'

/** Cards per page (the grid paginates locally, like the plugin overview). */
const CARDS_PER_PAGE = 24

type Bucket = 'all' | 'applied' | 'unapplied' | 'stale'

export default function McpView(): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [rows, setRows] = useState<McpLibOverviewRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [modal, setModal] = useState<{ open: boolean; editing: McpLibEntry | null }>({ open: false, editing: null })
  const [applyEntry, setApplyEntry] = useState<McpLibEntry | null>(null)
  // Apply targets — the view is library-first, so scopes load only for the
  // apply dialog (they never filter the cards).
  const [scopes, setScopes] = useState<DshScope[]>([])
  const [secrets, setSecrets] = useState<string[]>([])
  const [secretModal, setSecretModal] = useState(false)
  const [secretsOpen, setSecretsOpen] = useState(false)

  // Repository filters + local pagination.
  const [search, setSearch] = useState('')
  const [bucket, setBucket] = useState<Bucket>('all')
  const [page, setPage] = useState(1)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const [overview, secretNames] = await Promise.all([
      window.api.ext.libMcpOverview(),
      window.api.ext.mcpSecrets(),
    ])
    setLoading(false)
    if (!overview.ok) { void message.error(apiErrorText(overview)); return }
    setRows(overview.value)
    if (secretNames.ok) setSecrets(secretNames.value)
  }, [])

  useEffect(() => { void load() }, [load])

  // dsh/profile scopes for the apply dialog.
  useEffect(() => {
    void (async () => {
      const r = await window.api.plugins.installOptions()
      if (r.ok) setScopes(r.value)
    })()
  }, [])

  const save = async (previous: McpLibEntry | null, input: McpServerInput): Promise<void> => {
    setBusy('save')
    const r = await window.api.ext.libMcpSave(previous?.serverName ?? null, input)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.mcp.saved', { name: input.serverName }))
    setModal({ open: false, editing: null })
    await load()
  }

  const remove = async (entry: McpLibEntry): Promise<void> => {
    setBusy(`remove:${entry.serverName}`)
    const r = await window.api.ext.libMcpRemove(entry.serverName)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.mcp.removed', { name: entry.serverName }))
    await load()
  }

  const apply = async (target: McpApplyTarget): Promise<void> => {
    if (applyEntry === null) return
    setBusy('apply')
    const r = await window.api.ext.libMcpApply(applyEntry.serverName, target)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.mcp.applied', { name: applyEntry.serverName }))
    setApplyEntry(null)
    await load()
  }

  const sync = async (entry: McpLibEntry): Promise<void> => {
    setBusy(`sync:${entry.serverName}`)
    const r = await window.api.ext.libMcpSync(entry.serverName)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    const { updated, skipped } = r.value
    void (updated > 0
      ? message.success(t('ext.mcp.synced', { updated, skipped }))
      : message.info(t('ext.mcp.syncNone')))
    await load()
  }

  const saveSecret = async (name: string, value: string): Promise<void> => {
    setBusy('secret')
    const r = await window.api.ext.mcpSecretSet(name, value)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.secrets.saved', { name }))
    setSecretModal(false)
    setSecrets(prev => (prev.includes(name) ? prev : [...prev, name]))
  }

  const removeSecret = async (name: string): Promise<void> => {
    setBusy(`secret:${name}`)
    const r = await window.api.ext.mcpSecretRemove(name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setSecrets(prev => prev.filter(candidate => candidate !== name))
  }

  const entries = rows ?? []

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter(row => {
      if (bucket === 'applied' && row.applied === 0) return false
      if (bucket === 'unapplied' && row.applied > 0) return false
      if (bucket === 'stale' && row.stale === 0) return false
      if (q !== '') {
        const hay = [row.entry.serverName, row.entry.input.url, row.entry.input.command, ...(row.entry.input.args ?? [])]
          .filter(Boolean).join(' ').toLowerCase()
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

  const addServer = (): void => setModal({ open: true, editing: null })

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <SectionHeading
        title={t('ext.tab.mcp')}
        description={(
          <span>
            {rows !== null && (
              <>{t('ext.mcp.libSummary', { total: entries.length, applied: entries.reduce((sum, row) => sum + row.applied, 0) })} · </>
            )}
            {t('ext.mcp.libHint')}
          </span>
        )}
        extra={(
          <Space size={8} wrap>
            <Button size="small" icon={<KeyOutlined />} onClick={() => setSecretsOpen(true)}>
              {t('ext.mcp.manageSecrets')}
            </Button>
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              {t('common.refresh')}
            </Button>
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={addServer}>
              {t('ext.mcp.add')}
            </Button>
          </Space>
        )}
      />

      <Panel pad={false}>
        <Toolbar>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t('ext.mcp.searchPlaceholder')}
            ariaLabel={t('ext.mcp.searchPlaceholder')}
          />
          <Segmented
            value={bucket}
            onChange={value => setBucket(value as Bucket)}
            options={[
              { value: 'all', label: t('ext.mcp.bucket.all') },
              { value: 'applied', label: t('ext.mcp.bucket.applied') },
              { value: 'unapplied', label: t('ext.mcp.bucket.unapplied') },
              { value: 'stale', label: t('ext.mcp.bucket.stale') },
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
              title={entries.length === 0 ? t('ext.mcp.libEmpty') : t('common.noData')}
              description={entries.length === 0 ? t('ext.mcp.libEmptyDesc') : undefined}
              action={entries.length === 0 && bucket === 'all' && search.trim() === '' ? (
                <Button type="primary" icon={<PlusOutlined />} onClick={addServer}>{t('ext.mcp.add')}</Button>
              ) : undefined}
            />
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: token.padding }}>
                {paged.map(row => (
                  <McpCard
                    key={row.entry.serverName}
                    entry={row.entry}
                    applied={row.applied}
                    stale={row.stale}
                    handwritten={row.handwritten}
                    busy={busy === `sync:${row.entry.serverName}`}
                    onEdit={() => setModal({ open: true, editing: row.entry })}
                    onApply={() => setApplyEntry(row.entry)}
                    onSync={() => void sync(row.entry)}
                    onRemove={() => void remove(row.entry)}
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

      <McpServerModal
        open={modal.open}
        editing={modal.editing === null
          ? null
          : {
              // A library entry rendered as a row: the form only edits the
              // input fields, and the layer picker is hidden here.
              ...modal.editing.input,
              id: '',
              serverName: modal.editing.serverName,
              layer: 'profile',
              issues: [],
              disabled: false,
            }}
        layer="profile"
        onLayerChange={() => undefined}
        selectLayer={false}
        profileName=""
        storedNames={secrets}
        saving={busy === 'save'}
        onCancel={() => setModal({ open: false, editing: null })}
        onSubmit={input => void save(modal.editing, input)}
      />

      <ApplyMcpModal
        open={applyEntry !== null}
        entry={applyEntry}
        scopes={scopes}
        onCancel={() => setApplyEntry(null)}
        onApply={target => void apply(target)}
      />

      <SecretsManageModal
        open={secretsOpen}
        names={secrets}
        removing={busy.startsWith('secret:') ? busy.slice('secret:'.length) : undefined}
        onRemove={name => void removeSecret(name)}
        onAdd={() => setSecretModal(true)}
        onClose={() => setSecretsOpen(false)}
      />

      <McpSecretModal
        open={secretModal}
        saving={busy === 'secret'}
        onCancel={() => setSecretModal(false)}
        onSave={(name, value) => void saveSecret(name, value)}
      />
    </Space>
  )
}
