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
import type { ClassifiedRow, InsertConflict, InsertConflictLayer, ProfileLayer, ProfileLayerFile, ProfileValidation } from '../../../shared/types.ts'

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
  return fileNameLabel(layer, file.file)
}

/** The same label, from the file's NAME alone — what a row entry keeps of the file
 * it came from. */
export function fileNameLabel(layer: ProfileLayer, file: string | undefined): LayerLabel {
  return layerLabel({ source: layer.source, bundle: layer.bundle, label: layer.label, file })
}

/** One row of a layer, flattened with the patch file that serves it. */
export interface LayerRowEntry {
  /** Identity inside the layer — see {@link layerRowEntries}. */
  key: string
  /** The bundle-relative patch file, absent when the layer holds only one. */
  file?: string
  row: ClassifiedRow
}

/**
 * A layer's rows in application order, each tagged with its file.
 *
 * The key is `file + id`, because one bundle may declare the same id in two of its
 * patch files (and a single file may even repeat it): the two are separate rows the
 * host merges, and the detail pane must be able to select them independently. Two
 * rows sharing a key would move the highlight together.
 */
export function layerRowEntries(layer: ProfileLayer): LayerRowEntry[] {
  const entries: LayerRowEntry[] = []
  for (const file of layer.files) {
    const occurrences = new Map<string, number>()
    for (const row of file.rows) {
      const occurrence = occurrences.get(row.id) ?? 0
      occurrences.set(row.id, occurrence + 1)
      entries.push({
        key: `${file.file ?? ''}\u0000${row.id}\u0000${occurrence}`,
        ...(file.file === undefined ? {} : { file: file.file }),
        row,
      })
    }
  }
  return entries
}

/** Which actions a layer's rows allow. */
export interface RowActions {
  canToggle: boolean
  canCover: boolean
  canEdit: boolean
  canDelete: boolean
}

/** Whether a row answers the layer list's search box.
 *
 * Both the display name and the id are searched: the list shows the name, but the
 * id is what a user edits in the patch file and what the tags and the override
 * note speak of — matching only the visible text would hide the row a user is
 * looking for. A blank query matches everything, so clearing the box restores the
 * whole layer. */
export function rowMatchesQuery(row: ClassifiedRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return (row.name ?? '').toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle)
}

/**
 * The actions one layer's rows allow — the host's model, not a UI preference.
 *
 * A row a bundle ships is not editable: covering it copies it into the profile's
 * own layer, and THAT copy is what makes it editable. The home layer's rows can
 * only be switched on and off, and only the profile's own rows can be rewritten or
 * dropped. One place decides, so the list and the detail pane cannot offer
 * different things.
 */
export function rowActionsOf(layer: Pick<ProfileLayer, 'source' | 'bundle'>): RowActions {
  if (layer.source === 'bundle') {
    return { canToggle: false, canCover: layer.bundle !== undefined, canEdit: false, canDelete: false }
  }
  if (layer.source === 'home') return { canToggle: true, canCover: false, canEdit: false, canDelete: false }
  return { canToggle: true, canCover: false, canEdit: true, canDelete: true }
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

/** Every problem the diagnostics report counts for its badge: the boot-blocking
 * conflicts plus each finding of the last validation run. */
export function issueCount(conflicts: readonly InsertConflict[], validation: ProfileValidation | null): number {
  return conflicts.length
    + (validation?.manifestError !== undefined ? 1 : 0)
    + (validation?.patchErrors?.length ?? (validation?.patchError !== undefined ? 1 : 0))
    + (validation?.missingBundles.length ?? 0)
    + (validation?.unclaimedBundles.length ?? 0)
}
