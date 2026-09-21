/**
 * The profile workspace's layer labelling and issue counting.
 *
 * Two properties make this worth its own module:
 *
 * 1. It is pure and language-independent — labels come back as an i18n KEY plus
 *    its params, and the caller translates at render time. `lastSeenByRow` can
 *    therefore be memoized on `layers` alone. It previously depended on an
 *    in-component `layerLabel` rebuilt on every render, so the memo never hit.
 * 2. Being free of React and i18next, it is inside the vitest include and the
 *    branches below are actually asserted.
 */
import type { InsertConflict, InsertConflictLayer, ProfileLayer, ProfileValidation } from '../../../shared/types.ts'

/** An i18n key plus its interpolation params. */
export interface LayerLabel {
  key: 'profile.layer.bundle' | 'profile.layer.profile' | 'profile.layer.home' | 'profile.detail.patchLayer'
  options?: { name: string }
}

/** The label inputs a layer carries. Wider than `ProfileLayer`'s source union on
 * purpose: a conflict's layer list can also name a bare patch overlay, which is
 * the only place that case exists. */
type LabeledLayer = Pick<InsertConflictLayer, 'source' | 'bundle' | 'label'>

/** How one composed layer is named: its bundle, its profile, the home layer, or a
 * bare patch overlay. One function for both callers, since the branches are the
 * same — they only differed in which of them each caller could reach. */
export function layerLabel(layer: LabeledLayer): LayerLabel {
  if (layer.source === 'bundle') return { key: 'profile.layer.bundle', options: { name: layer.bundle ?? '' } }
  if (layer.source === 'profile') return { key: 'profile.layer.profile', options: { name: layer.label ?? '' } }
  if (layer.source === 'patch') return { key: 'profile.detail.patchLayer', options: { name: layer.label ?? '' } }
  return { key: 'profile.layer.home' }
}

/**
 * Which layer each row id is finally served by.
 *
 * Layers are ordered outermost-first, and dsh applies them in that order, so the
 * LAST layer that mentions an id is the one that wins. Hence the walk from the end
 * with first-mention-wins: an id is recorded by its innermost layer, not its
 * outermost.
 */
export function lastSeenByRow(layers: readonly ProfileLayer[]): Map<string, LayerLabel> {
  const seen = new Map<string, LayerLabel>()
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const label = layerLabel(layers[i])
    for (const row of layers[i].rows) if (!seen.has(row.id)) seen.set(row.id, label)
  }
  return seen
}

/** Every problem the inspector counts for its badge: the boot-blocking conflicts
 * plus each finding of the last validation run. */
export function issueCount(conflicts: readonly InsertConflict[], validation: ProfileValidation | null): number {
  return conflicts.length
    + (validation?.manifestError !== undefined ? 1 : 0)
    + (validation?.patchError !== undefined ? 1 : 0)
    + (validation?.missingBundles.length ?? 0)
    + (validation?.unclaimedBundles.length ?? 0)
}
