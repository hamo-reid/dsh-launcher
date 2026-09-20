/** One MCP-server card for the repository grid — mirrors PluginCard: the upper
 * region opens the edit modal when the row is editable; the footer carries the
 * enable switch and a kebab for edit / remove. All colours derive from theme
 * tokens per docs/ui-guidelines.md. */
import { useState } from 'react'
import { Alert, Button, Switch, Tag, Tooltip, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
import type { McpServer } from '../../../shared/types.ts'

export interface McpCardProps {
  server: McpServer
  /** The enable/disable switch is in flight. */
  toggling: boolean
  onToggle: (disabled: boolean) => void
  onEdit: () => void
  onRemove: () => void
}

export default function McpCard(p: McpCardProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [hovered, setHovered] = useState(false)
  const { server } = p

  const editable = server.layer !== 'bundle' && server.rawConfig === undefined
  const removable = server.layer !== 'bundle'
  const name = server.serverName || server.id

  const actions: MenuAction[] = [
    ...(editable ? [{ key: 'edit', label: t('common.edit') } as MenuAction] : []),
    ...(removable
      ? [{ key: 'remove', label: t('common.delete'), danger: true, confirmText: t('ext.mcp.removeConfirm', { name }) } as MenuAction]
      : []),
  ]
  const onAction = (key: string): void => {
    if (key === 'edit') p.onEdit()
    else if (key === 'remove') p.onRemove()
  }

  const layerTag = server.layer === 'bundle'
    ? <Tag key="layer">{t('ext.mcp.layerBundle', { bundle: server.bundle ?? '' })}</Tag>
    : <Tag key="layer" color={server.layer === 'home' ? 'purple' : 'blue'}>{t(`ext.mcp.layer.${server.layer}`)}</Tag>

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: token.padding,
        borderRadius: token.borderRadiusLG,
        border: `1px solid ${hovered ? token.colorPrimary : token.colorBorder}`,
        background: token.colorBgContainer,
        minHeight: 120,
        boxShadow: hovered ? token.boxShadowTertiary : 'none',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        opacity: server.disabled ? 0.65 : 1,
      }}
    >
      {/* Upper region — clickable into the edit modal when editable. */}
      {editable ? (
        <div
          role="button"
          tabIndex={0}
          aria-label={name}
          onClick={p.onEdit}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); p.onEdit() }
          }}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, cursor: 'pointer', outline: 'none' }}
        >
          <CardBody server={server} layerTag={layerTag} disabledTag />
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <CardBody server={server} layerTag={layerTag} disabledTag />
        </div>
      )}

      {/* Footer — the enable switch is the primary action; kebab carries edit /
          remove (a bundle row has neither, so no kebab at all). */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: token.paddingSM, paddingTop: token.paddingSM, borderTop: `1px solid ${token.colorSplit}` }}>
        <Tooltip title={t('ext.mcp.enabledHint')}>
          <Switch
            size="small"
            checked={!server.disabled}
            loading={p.toggling}
            onChange={checked => p.onToggle(!checked)}
          />
        </Tooltip>
        {actions.length > 0 && <ConfirmMenu actions={actions} onAction={onAction} />}
      </div>
    </div>
  )
}

/** The always-static part of the card: title, tags, endpoint, issues. */
function CardBody(props: { server: McpServer; layerTag: JSX.Element; disabledTag: boolean }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { server } = props
  const name = server.serverName || server.id
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span
          title={name}
          style={{ flex: 1, minWidth: 0, fontWeight: 600, color: token.colorText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {name}
        </span>
        {props.disabledTag && server.disabled && <Tag color="warning">{t('ext.mcp.disabled')}</Tag>}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <Tag>{server.transport || '—'}</Tag>
        {props.layerTag}
      </div>

      <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, wordBreak: 'break-all' }}>
        {server.transport === 'streamable-http'
          ? server.url ?? ''
          : [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')}
      </div>

      {server.layer === 'bundle' && (
        <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
          {t('ext.mcp.bundleHint')}
        </div>
      )}

      {server.rawConfig !== undefined && (
        <Alert
          type="warning"
          showIcon
          title={t('ext.mcp.rawConfig')}
          description={<pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{server.rawConfig}</pre>}
        />
      )}

      {server.issues.map((issue, i) => (
        <Alert
          key={i}
          type="error"
          showIcon
          title={t(`ext.mcp.issue.${issue.kind}`)}
          description={issue.detail !== undefined ? `${issue.message} — ${issue.detail}` : issue.message}
        />
      ))}
    </>
  )
}
