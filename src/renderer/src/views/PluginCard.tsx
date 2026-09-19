/** One installed-plugin card for the overview grid. The upper region opens the
 * detail modal (mouse + keyboard); the footer carries the primary action and a
 * kebab for reveal / uninstall / stale-removal. All colours derive from theme
 * tokens per docs/ui-guidelines.md. */
import { useState } from 'react'
import { Button, Space, Tag, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import ConfirmMenu, { type MenuAction } from '../components/ConfirmMenu.tsx'
import type {
  InstalledOverviewRow, MarketAnnotation, PluginKind, PluginProvenance, PluginUpdateInfo,
} from '../../../shared/types.ts'

/** Kind tag colours. */
const KIND_COLORS: Record<PluginKind, string> = {
  template: 'purple',
  bundle: 'geekblue',
  dependency: 'default',
  'store-only': 'default',
}

/** Provenance (management source) tag colours. */
const PROVENANCE_COLORS: Record<PluginProvenance, string> = {
  store: 'blue',
  official: 'purple',
  'sub-bundle': 'geekblue',
  'local-link': 'cyan',
  external: 'default',
}

/** i18n key suffix for a kind (`store-only` → `storeOnly`). */
const kindKey = (k: PluginKind): 'template' | 'bundle' | 'dependency' | 'storeOnly' =>
  k === 'store-only' ? 'storeOnly' : k
/** i18n key suffix for a provenance. */
const provKey = (p: PluginProvenance): 'store' | 'official' | 'subBundle' | 'localLink' | 'external' =>
  p === 'local-link' ? 'localLink' : p === 'sub-bundle' ? 'subBundle' : p

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let i = -1
  do { v /= 1024; i++ } while (v >= 1024 && i < units.length - 1)
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

export interface PluginCardProps {
  row: InstalledOverviewRow
  /** Update-check result for this plugin, when a check has run. */
  update?: PluginUpdateInfo
  /** Catalog annotation (category / deprecation), when the market is known. */
  annotation?: MarketAnnotation
  /** Localized label for `annotation.category`. */
  categoryLabel: string
  /** Real on-disk size, only after the manual size calculation. */
  sizeBytes?: number
  /** Store dir missing on disk. */
  stale: boolean
  onOpen: () => void
  onInstallToProfile: () => void
  onUninstall: () => void
  onReveal: () => void
  onDeleteStale: () => void
}

export default function PluginCard(p: PluginCardProps): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [hovered, setHovered] = useState(false)
  const { row, update, annotation } = p

  const versionsText = row.versions.length === 0
    ? '-'
    : row.versions.length === 1
      ? row.versions[0]
      : t('plugin.overview.nVersions', { count: row.versions.length })
  const dshCount = new Set(row.usage.map(u => u.dsh)).size

  const actions: MenuAction[] = [
    { key: 'reveal', label: t('plugin.detail.reveal') },
    ...(row.inStore === true
      ? [{ key: 'uninstall', label: t('plugin.detail.removeAllVersions'), danger: true, confirmText: t('plugin.detail.removeAllVersionsConfirm', { name: row.name }) } as MenuAction]
      : []),
    ...(p.stale
      ? [{ key: 'delete-stale', label: t('plugin.removeStale'), danger: true, confirmText: t('plugin.removeStaleConfirm', { name: row.name }) } as MenuAction]
      : []),
  ]
  const onAction = (key: string): void => {
    if (key === 'reveal') p.onReveal()
    else if (key === 'uninstall') p.onUninstall()
    else if (key === 'delete-stale') p.onDeleteStale()
  }

  const open = (): void => p.onOpen()

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
        minHeight: 150,
        boxShadow: hovered ? token.boxShadowTertiary : 'none',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
    >
      {/* Upper region — the clickable / keyboard-openable part (sibling of the
          action footer, so no interactive element is nested inside it). */}
      <div
        role="button"
        tabIndex={0}
        aria-label={row.name}
        onClick={open}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() }
        }}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, cursor: 'pointer', outline: 'none' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span
            title={row.name}
            style={{ flex: 1, minWidth: 0, fontWeight: 600, color: token.colorText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {row.name}
          </span>
          <Space size={4} wrap style={{ flexShrink: 0, justifyContent: 'flex-end' }}>
            {p.stale && <Tag color="error">{t('plugin.stale')}</Tag>}
            {update?.updateAvailable === true && <Tag color="gold">{t('plugin.status.update')}</Tag>}
            {update?.manual === true && <Tag>{t('plugin.status.manual')}</Tag>}
            {annotation?.deprecated === true && <Tag color="error">{t('plugin.status.deprecated')}</Tag>}
          </Space>
        </div>

        <Space size={4} wrap>
          <Tag color={KIND_COLORS[row.kind ?? 'dependency']}>{t(`plugin.kind.${kindKey(row.kind ?? 'dependency')}`)}</Tag>
          {(row.provenances ?? []).map(pr => (
            <Tag key={pr} color={PROVENANCE_COLORS[pr]}>{t(`plugin.provenance.${provKey(pr)}`)}</Tag>
          ))}
          {annotation !== undefined && <Tag>{p.categoryLabel}</Tag>}
        </Space>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>
          <span>{t('plugin.overview.colVersions')}: {versionsText}</span>
          {p.sizeBytes !== undefined && <span>{t('plugin.overview.colSize')}: {fmtBytes(p.sizeBytes)}</span>}
          <span>
            {t('plugin.overview.usageN', { count: row.usage.length })}
            {' · '}
            {t('plugin.overview.dshN', { count: dshCount })}
          </span>
        </div>
      </div>

      {/* Footer actions. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: token.paddingSM, paddingTop: token.paddingSM, borderTop: `1px solid ${token.colorSplit}` }}>
        {row.inStore === true
          ? <Button size="small" type="primary" onClick={p.onInstallToProfile}>{t('plugin.detail.installToProfile')}</Button>
          : <span />}
        <ConfirmMenu actions={actions} onAction={onAction} />
      </div>
    </div>
  )
}
