/**
 * MCP servers for one (dsh, profile).
 *
 * A row is an `insert:` entry mounting `@deepseek-ai/dsh-mcp-client`; its tools
 * appear as `mcp__<serverName>__<tool>`. Rows come from three layers — the
 * profile's own patch layer, the machine-level home layer, and a bundle — and the
 * list shows which. A shipped row is read-only apart from its off switch, which
 * writes an id-targeted override instead of a second insert.
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Empty, Popconfirm, Skeleton, Space, Switch, Tag, Tooltip, Typography, theme, message } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { apiErrorText } from '../lib/ipc.ts'
import Panel from '../components/Panel.tsx'
import Toolbar from '../components/Toolbar.tsx'
import McpServerModal from './ExtensionsModals.tsx'
import type { McpListing, McpServer, McpServerInput } from '../../../shared/types.ts'

/** Which layer a write targets: a shipped row is switched off in the profile
 * layer, everything else in its own. */
function writeLayerOf(server: McpServer): 'profile' | 'home' {
  return server.layer === 'home' ? 'home' : 'profile'
}

export default function McpView(props: { dshId?: string; profile?: string }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [listing, setListing] = useState<McpListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [modal, setModal] = useState<{ open: boolean; editing: McpServer | null; layer: 'profile' | 'home' }>(
    { open: false, editing: null, layer: 'profile' },
  )

  const { dshId, profile } = props

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
    void message.success(t('ext.mcp.removed', { name: server.serverName }))
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

  const layerTag = (server: McpServer): JSX.Element => {
    const colour = server.layer === 'bundle' ? 'default' : server.layer === 'home' ? 'purple' : 'blue'
    const label = server.layer === 'bundle'
      ? t('ext.mcp.layerBundle', { bundle: server.bundle ?? '' })
      : t(`ext.mcp.layer.${server.layer}`)
    return <Tag color={colour}>{label}</Tag>
  }

  const servers = listing?.servers ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Toolbar>
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          disabled={dshId === undefined || profile === undefined}
          onClick={() => setModal({ open: true, editing: null, layer: 'profile' })}
        >
          {t('ext.mcp.add')}
        </Button>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          {t('common.refresh')}
        </Button>
        <span style={{ flex: 1 }} />
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {t('ext.mcp.toolPrefixHint')}
        </Typography.Text>
      </Toolbar>

      <div style={{ flex: 1, overflow: 'auto', padding: token.padding }}>
        {loading && servers.length === 0 ? (
          <Skeleton active />
        ) : servers.length === 0 ? (
          <Empty description={t('ext.mcp.empty')} />
        ) : (
          <Panel pad>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {servers.map(server => (
                <div
                  key={`${server.layer}:${server.id}`}
                  style={{
                    border: `1px solid ${token.colorSplit}`,
                    borderRadius: token.borderRadius,
                    padding: token.paddingSM,
                    opacity: server.disabled ? 0.6 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Typography.Text strong>{server.serverName || server.id}</Typography.Text>
                    <Tag>{server.transport || '—'}</Tag>
                    {layerTag(server)}
                    {server.disabled && <Tag color="default">{t('ext.mcp.disabled')}</Tag>}
                    <span style={{ flex: 1 }} />
                    <Tooltip title={t('ext.mcp.enabledHint')}>
                      <Switch
                        size="small"
                        checked={!server.disabled}
                        loading={busy === `toggle:${server.id}`}
                        onChange={checked => void setDisabled(server, !checked)}
                      />
                    </Tooltip>
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      disabled={server.layer === 'bundle' || server.rawConfig !== undefined}
                      onClick={() => setModal({ open: true, editing: server, layer: writeLayerOf(server) })}
                    />
                    <Popconfirm
                      title={t('ext.mcp.removeConfirm', { name: server.serverName || server.id })}
                      okText={t('common.delete')}
                      cancelText={t('common.cancel')}
                      onConfirm={() => void remove(server)}
                    >
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        loading={busy === `remove:${server.id}`}
                        disabled={server.layer === 'bundle'}
                      />
                    </Popconfirm>
                  </div>

                  <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, marginTop: 4 }}>
                    {server.transport === 'streamable-http'
                      ? server.url ?? ''
                      : [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')}
                  </div>

                  {server.layer === 'bundle' && (
                    <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, marginTop: 2 }}>
                      {t('ext.mcp.bundleHint')}
                    </div>
                  )}

                  {server.rawConfig !== undefined && (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginTop: 6 }}
                      title={t('ext.mcp.rawConfig')}
                      description={<pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{server.rawConfig}</pre>}
                    />
                  )}

                  {server.issues.map((issue, i) => (
                    <Alert
                      key={i}
                      type="error"
                      showIcon
                      style={{ marginTop: 6 }}
                      title={t(`ext.mcp.issue.${issue.kind}`)}
                      description={issue.detail !== undefined ? `${issue.message} — ${issue.detail}` : issue.message}
                    />
                  ))}
                </div>
              ))}
            </Space>
          </Panel>
        )}
      </div>

      <McpServerModal
        open={modal.open}
        editing={modal.editing}
        layer={modal.layer}
        onLayerChange={layer => setModal(prev => ({ ...prev, layer }))}
        profileName={profile ?? ''}
        saving={busy === 'save'}
        onCancel={() => setModal({ open: false, editing: null, layer: 'profile' })}
        onSubmit={input => void save(input)}
      />
    </div>
  )
}
