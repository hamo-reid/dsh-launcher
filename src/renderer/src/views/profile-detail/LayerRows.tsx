/**
 * One composed layer's rows, with the per-row actions.
 *
 * The buttons differ by layer: a bundle layer's rows can only be "covered" (copied
 * into the profile layer, since a shipped row is not editable), the home layer's
 * rows can be enabled/disabled, and only the profile's own layer can be edited or
 * deleted — those rows are the ones the profile owns.
 */
import { Button, Space, Tag, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import StatusTag from '../../components/StatusTag.tsx'
import { layerLabel, type LayerLabel } from '../../lib/profileLayers.ts'
import type { ProfileLayer } from '../../../../shared/types.ts'

/** Which editor a row's action opens — the config override or the insert list. */
type EditKind = 'config' | 'insert'

interface Props {
  layer: ProfileLayer
  /** Which layer serves each row id, so a row overridden elsewhere can say so. */
  lastSeen: Map<string, LayerLabel>
  /** Enable/disable the row in THIS layer. */
  onToggle: (id: string, disabled: boolean) => void
  /** Copy a bundle's row into the profile layer as an editable override. */
  onCover: (id: string) => void
  onEdit: (id: string, kind: EditKind) => void
  /** Drop the profile layer's override of a row (its bundle default returns). */
  onRemoveCover: (id: string) => void
}

export default function LayerRows({ layer, lastSeen, onToggle, onCover, onEdit, onRemoveCover }: Props): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  // Labels travel as i18n keys, so any comparison between two of them happens on
  // their text.
  const labelTextOf = (label: LayerLabel): string => t(label.key, label.options)
  const here = labelTextOf(layerLabel(layer))

  /** The row's own layer is not an "override"; any other layer serving it is. */
  const overrideOf = (id: string): LayerLabel | undefined => {
    const seen = lastSeen.get(id)
    return seen !== undefined && labelTextOf(seen) !== here ? seen : undefined
  }

  const rowActions = (id: string, disabled: boolean): JSX.Element | null => {
    if (layer.source === 'bundle') {
      return layer.bundle !== undefined
        ? <Button size="small" onClick={() => onCover(id)}>{t('profile.detail.row.cover')}</Button>
        : null
    }
    return (
      <Space size={4}>
        <Button size="small" onClick={() => onToggle(id, !disabled)}>{disabled ? t('profile.detail.row.enable') : t('profile.detail.row.disable')}</Button>
        {layer.source === 'profile' && (
          <>
            <Button size="small" onClick={() => onEdit(id, 'config')}>{t('profile.detail.row.config')}</Button>
            <Button size="small" onClick={() => onEdit(id, 'insert')}>{t('profile.detail.row.insert')}</Button>
            <Button size="small" danger type="text" onClick={() => onRemoveCover(id)}>{t('profile.detail.row.delete')}</Button>
          </>
        )}
      </Space>
    )
  }

  if (layer.rows.length === 0) {
    return <div style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>{t('profile.detail.layerNoRows')}</div>
  }

  return (
    <div>
      {layer.rows.map((row) => {
        const override = overrideOf(row.id)
        return (
          <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${token.colorSplit}` }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
              {row.name ?? row.id}
            </span>
            <StatusTag tone={row.disabled ? 'disabled' : 'enabled'}>{row.disabled ? t('profile.detail.disabled') : t('profile.detail.enabled')}</StatusTag>
            {row.hasConfig && <Tag>config</Tag>}
            {row.hasInsert && <Tag>insert</Tag>}
            {override !== undefined && <Tag style={{ color: token.colorTextTertiary, borderColor: token.colorBorder }}>{t('profile.detail.overridden', { override: labelTextOf(override) })}</Tag>}
            {rowActions(row.id, row.disabled)}
          </div>
        )
      })}
    </div>
  )
}
