/**
 * MCP servers — the repository view of the MCP track.
 *
 * A row is an `insert:` entry mounting `@deepseek-ai/dsh-mcp-client`; its tools
 * appear as `mcp__<serverName>__<tool>`. Rows come from three layers — the
 * profile's own patch layer, the machine-level home layer, and a bundle — and a
 * card shows which. A shipped row is read-only apart from its off switch, which
 * writes an id-targeted override instead of a second insert.
 *
 * Layout mirrors the plugins section: a heading that carries the target
 * pickers and actions, then a searchable / filterable card grid with local
 * pagination.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Pagination, Segmented, Select, Skeleton, Space, theme, message } from 'antd'
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
import type { McpListing, McpServer, McpServerInput } from '../../../shared/types.ts'

/** Cards per page (the grid paginates locally, like the plugin overview). */
const CARDS_PER_PAGE = 24

type Bucket = 'all' | 'enabled' | 'disabled' | 'readonly'

/** Which layer a write targets: a shipped row is switched off in the profile
 * layer, everything else in its own. */
function writeLayerOf(server: McpServer): 'profile' | 'home' {
  return server.layer === 'home' ? 'home' : 'profile'
}

/** A shipped row (bundle) or one the form cannot parse is read-only. */
function isReadonly(server: McpServer): boolean {
  return server.layer === 'bundle' || server.rawConfig !== undefined
}

/** One dsh and the profiles it holds, for the target picker. */
interface DshScope { id: string; name: string; profiles: string[] }

export default function McpView(): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  // Target context — the view is self-contained (like the plugins views) and
  // owns its dsh / profile pickers.
  const [scopes, setScopes] = useState<DshScope[]>([])
  const [dshId, setDshId] = useState<string>()
  const [profile, setProfile] = useState<string>()

  const [listing, setListing] = useState<McpListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [modal, setModal] = useState<{ open: boolean; editing: McpServer | null; layer: 'profile' | 'home' }>(
    { open: false, editing: null, layer: 'profile' },
  )
  const [secrets, setSecrets] = useState<string[]>([])
  const [secretModal, setSecretModal] = useState(false)
  const [secretsOpen, setSecretsOpen] = useState(false)

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

  // Keep the selected profile valid for the selected dsh (a dsh switch, or a
  // profile deleted elsewhere, must not leave a stale target).
  useEffect(() => {
    const profiles = scopes.find(scope => scope.id === dshId)?.profiles ?? []
    setProfile(prev => (prev !== undefined && profiles.includes(prev)) ? prev : profiles[0])
  }, [scopes, dshId])

  const loadSecrets = useCallback(async (): Promise<void> => {
    const r = await window.api.ext.mcpSecrets()
    if (r.ok) setSecrets(r.value)
  }, [])

  useEffect(() => { void loadSecrets() }, [loadSecrets])

  const load = useCallback(async (): Promise<void> => {
    if (dshId === undefined || profile === undefined) { setListing(null); return }
    setLoading(true)
    const r = await window.api.ext.mcpList(dshId, profile)
    setLoading(false)
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    setListing(r.value)
  }, [dshId, profile])

  useEffect(() => { void load() }, [load])

  const save = async (input: McpServerInput): Promise<void> => {
    if (dshId === undefined || profile === undefined) return
    const layer = modal.editing === null ? modal.layer : writeLayerOf(modal.editing)
    setBusy('save')
    const r = await window.api.ext.mcpSave(dshId, profile, input, layer)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.mcp.saved', { name: input.serverName }))
    setModal({ open: false, editing: null, layer: 'profile' })
    await load()
  }

  const remove = async (server: McpServer): Promise<void> => {
    if (dshId === undefined || profile === undefined) return
    setBusy(`remove:${server.id}`)
    const r = await window.api.ext.mcpRemove(dshId, profile, server.id, writeLayerOf(server))
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.mcp.removed', { name: server.serverName || server.id }))
    await load()
  }

  const setDisabled = async (server: McpServer, disabled: boolean): Promise<void> => {
    if (dshId === undefined || profile === undefined) return
    setBusy(`toggle:${server.id}`)
    const r = await window.api.ext.mcpSetDisabled(dshId, profile, server.id, disabled, writeLayerOf(server))
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    await load()
  }

  const saveSecret = async (name: string, value: string): Promise<void> => {
    setBusy('secret')
    const r = await window.api.ext.mcpSecretSet(name, value)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.secrets.saved', { name }))
    setSecretModal(false)
    await loadSecrets()
  }

  const removeSecret = async (name: string): Promise<void> => {
    setBusy(`secret:${name}`)
    const r = await window.api.ext.mcpSecretRemove(name)
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    await loadSecrets()
  }

  const servers = listing?.servers ?? []
  const enabledCount = servers.filter(server => !server.disabled).length
  const readonlyCount = servers.filter(isReadonly).length

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return servers.filter(server => {
      if (bucket === 'enabled' && server.disabled) return false
      if (bucket === 'disabled' && !server.disabled) return false
      if (bucket === 'readonly' && !isReadonly(server)) return false
      if (q !== '') {
        const hay = [server.serverName, server.id, server.url, server.command, ...(server.args ?? [])]
          .filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [servers, search, bucket])

  // Reset to the first page whenever the filter changes.
  useEffect(() => { setPage(1) }, [search, bucket])

  const lastPage = Math.max(1, Math.ceil(filtered.length / CARDS_PER_PAGE))
  const currentPage = Math.min(page, lastPage)
  const paged = filtered.slice((currentPage - 1) * CARDS_PER_PAGE, currentPage * CARDS_PER_PAGE)

  const ready = dshId !== undefined && profile !== undefined
  const addServer = (): void => setModal({ open: true, editing: null, layer: 'profile' })

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <SectionHeading
        title={t('ext.tab.mcp')}
        description={(
          <span>
            {listing !== null && (
              <>{t('ext.mcp.summary', { total: servers.length, enabled: enabledCount, readonly: readonlyCount })} · </>
            )}
            {t('ext.mcp.toolPrefixHint')}
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
            <Select
              size="small"
              style={{ minWidth: 170 }}
              showSearch
              optionFilterProp="label"
              value={profile}
              placeholder={t('ext.target.profile')}
              onChange={name => setProfile(name)}
              disabled={dshId === undefined}
              options={(scopes.find(scope => scope.id === dshId)?.profiles ?? []).map(name => ({ value: name, label: name }))}
            />
            <Button size="small" icon={<KeyOutlined />} onClick={() => setSecretsOpen(true)}>
              {t('ext.mcp.manageSecrets')}
            </Button>
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              {t('common.refresh')}
            </Button>
            <Button type="primary" size="small" icon={<PlusOutlined />} disabled={!ready} onClick={addServer}>
              {t('ext.mcp.add')}
            </Button>
          </Space>
        )}
      />

      {!ready ? (
        <EmptyState title={scopes.length === 0 ? t('ext.target.noDsh') : t('ext.target.noProfile')} />
      ) : (
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
                { value: 'enabled', label: t('ext.mcp.bucket.enabled') },
                { value: 'disabled', label: t('ext.mcp.bucket.disabled') },
                { value: 'readonly', label: t('ext.mcp.bucket.readonly') },
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
            ) : filtered.length === 0 ? (
              <EmptyState
                title={servers.length === 0 ? t('ext.mcp.empty') : t('common.noData')}
                description={servers.length === 0 ? t('ext.mcp.emptyDesc') : undefined}
                action={servers.length === 0 && bucket === 'all' && search.trim() === '' ? (
                  <Button type="primary" icon={<PlusOutlined />} onClick={addServer}>{t('ext.mcp.add')}</Button>
                ) : undefined}
              />
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: token.padding }}>
                  {paged.map(server => (
                    <McpCard
                      key={`${server.layer}:${server.id}`}
                      server={server}
                      toggling={busy === `toggle:${server.id}`}
                      onToggle={disabled => void setDisabled(server, disabled)}
                      onEdit={() => setModal({ open: true, editing: server, layer: writeLayerOf(server) })}
                      onRemove={() => void remove(server)}
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
      )}

      <McpServerModal
        open={modal.open}
        editing={modal.editing}
        layer={modal.layer}
        onLayerChange={layer => setModal(prev => ({ ...prev, layer }))}
        profileName={profile ?? ''}
        storedNames={secrets}
        saving={busy === 'save'}
        onCancel={() => setModal({ open: false, editing: null, layer: 'profile' })}
        onSubmit={input => void save(input)}
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
