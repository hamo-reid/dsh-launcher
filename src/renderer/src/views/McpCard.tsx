/** One MCP-library card for the repository grid — mirrors PluginCard: the upper
 * region opens the edit modal; the footer carries the "apply…" action and a
 * kebab for edit / sync / remove. The usage line summarizes where the entry is
 * materialized (applied rows are copies keyed by `serverName`). All colours
 * derive from theme tokens per docs/ui-guidelines.md. */
import { useState } from 'react'
import { Button, Tag, Tooltip, theme } from 'antd'
import { SyncOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
import type { McpLibEntry } from '../../../shared/types.ts'

export interface McpCardProps {
  entry: McpLibEntry
  /** How many profile/home rows carry this `serverName`. */
  applied: number
  /** How many of those have drifted from the library (syncable). */
  stale: number
  /** How many are raw/handwritten (shown, never synced). */
  handwritten: number
  /** The sync action is in flight. */
  busy: boolean
  onEdit: () => void
  onApply: () => void
  onSync: () => void
  onRemove: () => void
}

export default function McpCard(p: McpCardProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [hovered, setHovered] = useState(false)
  const { entry } = p

  const actions: MenuAction[] = [
    { key: 'edit', label: t('common.edit') },
    ...(p.stale > 0 ? [{ key: 'sync', label: t('ext.mcp.sync') } as MenuAction] : []),
    { key: 'remove', label: t('common.delete'), danger: true, confirmText: t('ext.mcp.removeLibConfirm', { name: entry.serverName }) },
  ]
  const onAction = (key: string): void => {
    if (key === 'edit') p.onEdit()
    else if (key === 'sync') p.onSync()
    else if (key === 'remove') p.onRemove()
  }

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
        minHeight: 140,
        boxShadow: hovered ? token.boxShadowTertiary : 'none',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
    >
      {/* Upper region — clickable into the edit modal. */}
      <div
        role="button"
        tabIndex={0}
        aria-label={entry.serverName}
        onClick={p.onEdit}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); p.onEdit() }
        }}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, cursor: 'pointer', outline: 'none' }}
      >
        <CardBody entry={entry} applied={p.applied} stale={p.stale} handwritten={p.handwritten} />
      </div>

      {/* Footer — "apply…" is the primary action; kebab carries edit / sync /
          remove. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: token.paddingSM, paddingTop: token.paddingSM, borderTop: `1px solid ${token.colorSplit}` }}>
        <Button size="small" type="primary" onClick={p.onApply}>
          {t('ext.mcp.apply')}
        </Button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {p.stale > 0 && (
            <Tooltip title={t('ext.mcp.syncHint')}>
              <Button size="small" icon={<SyncOutlined />} loading={p.busy} onClick={p.onSync}>
                {p.stale}
              </Button>
            </Tooltip>
          )}
          <ConfirmMenu actions={actions} onAction={onAction} />
        </span>
      </div>
    </div>
  )
}

/** The always-static part of the card: title, tags, endpoint, usage. */
function CardBody(props: { entry: McpLibEntry; applied: number; stale: number; handwritten: number }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { entry } = props
  const envNames = entry.input.env?.map(kv => kv.name).filter(Boolean) ?? []
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span
          title={entry.serverName}
          style={{ flex: 1, minWidth: 0, fontWeight: 600, color: token.colorText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {entry.serverName}
        </span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <Tag>{entry.input.transport}</Tag>
        {props.applied > 0
          ? <Tag color={props.stale > 0 ? 'warning' : 'success'}>{t('ext.mcp.appliedCount', { count: props.applied })}</Tag>
          : <Tag color="default">{t('ext.mcp.notApplied')}</Tag>}
        {props.handwritten > 0 && <Tag color="purple">{t('ext.mcp.handwrittenCount', { count: props.handwritten })}</Tag>}
      </div>

      <div style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM, wordBreak: 'break-all' }}>
        {entry.input.transport === 'streamable-http'
          ? entry.input.url ?? ''
          : [entry.input.command, ...(entry.input.args ?? [])].filter(Boolean).join(' ')}
      </div>

      {envNames.length > 0 && (
        <Tooltip title={t('ext.mcp.envNamesHint')}>
          <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            env: {envNames.join(', ')}
          </div>
        </Tooltip>
      )}
    </>
  )
}
