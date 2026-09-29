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
import type { InsertConflict, InsertConflictLayer, ProfileLayer, ProfileLayerFile, ProfileValidation } from '../../../shared/types.ts'

/** An i18n key plus its interpolation params. */
export interface LayerLabel {
  key:
    | 'profile.layer.bundle'
    | 'profile.layer.bundleFile'
    | 'profile.layer.profile'
    | 'profile.layer.home'
    | 'profile.detail.patchLayer'
  options?: { name: string; file?: string }
}

/** The label inputs a layer carries. Wider than `ProfileLayer`'s source union on
 * purpose: a conflict's layer list can also name a bare patch overlay, which is
 * the only place that case exists. `file` is what tells two patch files of one
 * bundle apart — without it their labels are equal, and both the row provenance
 * and the conflict list compare these as TEXT. */
type LabeledLayer = Pick<InsertConflictLayer, 'source' | 'bundle' | 'label' | 'file'>

/** How one composed layer is named: its bundle (qualified by file when the bundle
 * composes several), its profile, the home layer, or a bare patch overlay. One
 * function for every caller, since the branches are the same — they only differed
 * in which of them each caller could reach. */
export function layerLabel(layer: LabeledLayer): LayerLabel {
  if (layer.source === 'bundle') {
    const name = layer.bundle ?? ''
    return layer.file === undefined || layer.file === ''
      ? { key: 'profile.layer.bundle', options: { name } }
      : { key: 'profile.layer.bundleFile', options: { name, file: layer.file } }
  }
  if (layer.source === 'profile') return { key: 'profile.layer.profile', options: { name: layer.label ?? '' } }
  if (layer.source === 'patch') return { key: 'profile.detail.patchLayer', options: { name: layer.label ?? '' } }
  return { key: 'profile.layer.home' }
}

/** How one FILE inside a layer is named. A single-file layer has no qualifier, so
 * this is the layer's own label; a multi-file bundle's file is its own identity. */
export function fileLabel(layer: ProfileLayer, file: ProfileLayerFile): LayerLabel {
  return layerLabel({ source: layer.source, bundle: layer.bundle, label: layer.label, file: file.file })
}

/** How many rows a layer holds across all of its patch files. */
export function layerRowCount(layer: ProfileLayer): number {
  return layer.files.reduce((total, file) => total + file.rows.length, 0)
}

/**
 * Which patch FILE each row id is finally served by.
 *
 * Layers are ordered outermost-first and dsh applies them in that order, so within
 * a layer its last file mentioning an id wins, and across layers the last layer
 * does. Hence a walk from the end with first-mention-wins: an id is recorded by
 * its innermost file, not its outermost.
 */
export function lastSeenByRow(layers: readonly ProfileLayer[]): Map<string, LayerLabel> {
  const seen = new Map<string, LayerLabel>()
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const files = layers[i].files
    for (let f = files.length - 1; f >= 0; f -= 1) {
      const label = fileLabel(layers[i], files[f])
      for (const row of files[f].rows) if (!seen.has(row.id)) seen.set(row.id, label)
    }
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
