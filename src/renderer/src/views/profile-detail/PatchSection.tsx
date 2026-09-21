/**
 * The patch section's body: one card per composed layer, in application order.
 *
 * The comments that lived here are kept, because both encode a fixed bug: the action
 * buttons belong to the panel header (this body used to repeat two of them, so the
 * same button rendered twice), and a card's key must be the layer's IDENTITY — an
 * index key would remount every card on a bundle reorder.
 */
import ActionCard from '../../components/ActionCard.tsx'
import { layerLabel } from '../../lib/profileLayers.ts'
import { useTranslation } from 'react-i18next'
import type { ProfileLayer } from '../../../../shared/types.ts'

interface Props {
  /** The composed stack, outermost first. `null` while it loads. */
  layers: ProfileLayer[] | null
  onOpenLayer: (index: number) => void
}

export default function PatchSection({ layers, onOpenLayer }: Props): JSX.Element {
  const { t } = useTranslation()

  /** The layer identity, as the card list and dnd both need it. */
  const keyOf = (layer: ProfileLayer): string =>
    layer.source === 'bundle' ? `bundle:${layer.bundle}` : layer.source === 'profile' ? `profile:${layer.label}` : 'home'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {(layers ?? []).map((layer, i) => {
        const label = layerLabel(layer)
        return (
          <ActionCard
            key={keyOf(layer)}
            title={`${i + 1}. ${t(label.key, label.options)}`}
            meta={layer.source === 'profile'
              ? t('profile.detail.layerMetaEditable', { count: layer.rows.length })
              : t('profile.detail.layerMeta', { count: layer.rows.length })}
            onClick={() => onOpenLayer(i)}
            hoverable
          />
        )
      })}
    </div>
  )
}
