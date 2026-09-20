/**
 * MCP servers for ONE binding context — the profile side of the extensions
 * model. `profile !== null` shows every row the profile resolves (bundle →
 * profile → home) and targets writes at the profile layer; `profile === null`
 * is the home-only scope used on the DSH page (rows that apply to every
 * profile of the dsh).
 *
 * Rows are materialized patch rows: toggling writes the disable override,
 * removing rewrites the patch, and new rows come from the launcher-global
 * library ("add from library") — creation lives there, not here. Handwritten
 * (raw) rows are shown but never touched.
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Empty, Space, Switch, Tag, Tooltip, theme, message } from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { apiErrorText } from '../lib/ipc.ts'
import Panel from '../components/Panel.tsx'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
import McpServerModal from './ExtensionsModals.tsx'
import { PickLibMcpModal } from './LibraryModals.tsx'
import type { McpIssue, McpLibEntry, McpServer, McpServerInput } from '../../../shared/types.ts'

/** Localized label per issue kind — keyed explicitly so a new McpIssue kind
 * fails the typecheck until it gets a label. */
function issueLabel(issue: McpIssue, t: TFunction<'translation'>): string {
  const labels: Record<McpIssue['kind'], string> = {
    'bad-server-name': t('ext.mcp.issue.bad-server-name'),
    'missing-transport': t('ext.mcp.issue.missing-transport'),
    'unknown-transport': t('ext.mcp.issue.unknown-transport'),
    'missing-command': t('ext.mcp.issue.missing-command'),
    'missing-url': t('ext.mcp.issue.missing-url'),
    'duplicate-server-name': t('ext.mcp.issue.duplicate-server-name'),
    'unparsable-config': t('ext.mcp.issue.unparsable-config'),
  }
  return labels[issue.kind]
}

/** Which layer a write targets: a shipped row (bundle) is switched off via an
 * id-targeted override in the profile layer, everything else in its own. */
function writeLayerOf(server: McpServer): 'profile' | 'home' {
  return server.layer === 'home' ? 'home' : 'profile'
}

export interface McpManagePanelProps {
  dshId: string
  /** The profile whose rows are managed, or `null` for the home-only scope. */
  profile: string | null
  /** Wrap in the section Panel (dsh page); bare content otherwise (the
   * profile detail page renders inside its own section panel). */
  withPanel?: boolean
  /** Panel title override (defaults to the per-scope label). */
  title?: string
}

export default function McpManagePanel(p: McpManagePanelProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [servers, setServers] = useState<McpServer[] | null>(null)
  const [libEntries, setLibEntries] = useState<McpLibEntry[]>([])
  const [secrets, setSecrets] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState<McpServer | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [pickOpen, setPickOpen] = useState(false)

  const homeOnly = p.profile === null

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    if (homeOnly) {
      const r = await window.api.ext.mcpHomeList(p.dshId)
      if (!r.ok) { setLoading(false); void message.error(apiErrorText(r)); return }
      setServers(r.value)
    } else {
      const r = await window.api.ext.mcpList(p.dshId, p.profile ?? '')
      if (!r.ok) { setLoading(false); void message.error(apiErrorText(r)); return }
      setServers(r.value.servers)
    }
    const [lib, secretNames] = await Promise.all([
      window.api.ext.libMcpOverview(),
      window.api.ext.mcpSecrets(),
    ])
    setLoading(false)
    if (lib.ok) setLibEntries(lib.value.map(row => row.entry))
    if (secretNames.ok) setSecrets(secretNames.value)
  }, [p.dshId, p.profile, homeOnly])

  useEffect(() => { void load() }, [load])

  const setDisabled = async (server: McpServer, disabled: boolean): Promise<void> => {
    setBusy(`toggle:${server.id}`)
    const r = await window.api.ext.mcpSetDisabled(p.dshId, p.profile ?? '', server.id, disabled, writeLayerOf(server))
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    await load()
  }

  const remove = async (server: McpServer): Promise<void> => {
    setBusy(`remove:${server.id}`)
    const r = await window.api.ext.mcpRemove(p.dshId, p.profile ?? '', server.id, writeLayerOf(server))
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.mcp.removed', { name: server.serverName || server.id }))
    await load()
  }

  const saveEdit = async (input: McpServerInput): Promise<void> => {
    if (editing === null) return
    setBusy('save')
    const r = await window.api.ext.mcpSave(p.dshId, p.profile ?? '', input, writeLayerOf(editing))
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.mcp.saved', { name: input.serverName }))
    setModalOpen(false)
    setEditing(null)
    await load()
  }

  const applyEntry = async (entry: McpLibEntry): Promise<void> => {
    setPickOpen(false)
    setBusy('apply')
    const r = await window.api.ext.libMcpApply(entry.serverName, homeOnly
      ? { dshId: p.dshId, layer: 'home' }
      : { dshId: p.dshId, layer: 'profile', profile: p.profile ?? '' })
    setBusy('')
    if (!r.ok) { void message.error(apiErrorText(r)); return }
    void message.success(t('ext.mcp.applied', { name: entry.serverName }))
    await load()
  }

  // Rows already carrying a serverName in the writable target layer block a
  // second insert of the same entry.
  const appliedNames = (servers ?? [])
    .filter(server => homeOnly ? server.layer === 'home' : server.layer !== 'bundle')
    .map(server => server.serverName)

  const actionRow = (
    <Space size={8} wrap>
      <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setPickOpen(true)}>
        {t('ext.mcp.pickFromLib')}
      </Button>
      <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
        {t('common.refresh')}
      </Button>
    </Space>
  )

  const content = (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {!p.withPanel && actionRow}
      {(servers ?? []).length === 0 && !loading && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t(homeOnly ? 'ext.mcp.homeEmpty' : 'ext.mcp.profileEmpty')} />
      )}
      {(servers ?? []).map(server => {
        const raw = server.rawConfig !== undefined
        const bundle = server.layer === 'bundle'
        const name = server.serverName || server.id
        const actions: MenuAction[] = [
          ...(!raw ? [{ key: 'edit', label: t('common.edit') } as MenuAction] : []),
          ...(!bundle
            ? [{ key: 'remove', label: t('common.delete'), danger: true, confirmText: t('ext.mcp.removeConfirm', { name }) } as MenuAction]
            : []),
        ]
        return (
          <div key={`${server.layer}:${server.id}`} style={{ borderBottom: `1px solid ${token.colorSplit}`, paddingBottom: 8, opacity: server.disabled ? 0.65 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span title={name} style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {name}
              </span>
              {!homeOnly && (
                <Tag color={bundle ? 'default' : server.layer === 'home' ? 'purple' : 'blue'}>
                  {bundle
                    ? t('ext.mcp.layerBundle', { bundle: server.bundle ?? '' })
                    : server.layer === 'home' ? t('ext.mcp.layer.home') : t('ext.mcp.layer.profile')}
                </Tag>
              )}
              <Tooltip title={t('ext.mcp.enabledHint')}>
                <Switch
                  size="small"
                  checked={!server.disabled}
                  loading={busy === `toggle:${server.id}`}
                  onChange={checked => void setDisabled(server, !checked)}
                />
              </Tooltip>
              {actions.length > 0 && (
                <ConfirmMenu
                  actions={actions}
                  onAction={key => {
                    if (key === 'edit') { setEditing(server); setModalOpen(true) }
                    else if (key === 'remove') void remove(server)
                  }}
                />
              )}
            </div>
            <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, wordBreak: 'break-all' }}>
              {server.transport === 'streamable-http'
                ? server.url ?? ''
                : [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')}
            </div>
            {server.issues.length > 0 && (
              <Alert
                style={{ marginTop: 4 }}
                type="error"
                showIcon
                title={t('ext.mcp.rowIssues')}
                description={server.issues.map(issue => issueLabel(issue, t)).join(' · ')}
              />
            )}
            {raw && (
              <Alert
                style={{ marginTop: 4 }}
                type="warning"
                showIcon
                title={t('ext.mcp.rawConfig')}
                description={<pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{server.rawConfig}</pre>}
              />
            )}
          </div>
        )
      })}
    </Space>
  )

  const modals = (
    <>
      <PickLibMcpModal
        open={pickOpen}
        entries={libEntries}
        appliedNames={appliedNames}
        busy={busy === 'apply' ? 'apply' : null}
        onCancel={() => setPickOpen(false)}
        onPick={entry => void applyEntry(entry)}
      />
      <McpServerModal
        open={modalOpen}
        editing={editing}
        layer={editing === null ? 'profile' : writeLayerOf(editing)}
        onLayerChange={() => undefined}
        profileName={p.profile ?? ''}
        storedNames={secrets}
        saving={busy === 'save'}
        onCancel={() => { setModalOpen(false); setEditing(null) }}
        onSubmit={input => void saveEdit(input)}
      />
    </>
  )

  if (p.withPanel !== true) {
    return (
      <>
        {content}
        {modals}
      </>
    )
  }

  return (
    <>
      <Panel
        title={p.title ?? t(homeOnly ? 'ext.mcp.homeTitle' : 'ext.mcp.profileTitle')}
        extra={actionRow}
      >
        {content}
      </Panel>
      {modals}
    </>
  )
}
