/**
 * Which preset model a profile mounts, and the patch layers its roster comes
 * from.
 *
 * The model is read off the COMPOSITION — which of the two preset plugin
 * packages the profile's patch stack actually declares — never off a version
 * number. A version says what was installed; the composition says what runs, and
 * those differ whenever a profile still selects an older bundle, or a newer one
 * is installed but not composed. It is a per-profile answer for the same reason:
 * two profiles of one dsh may select different bundle versions.
 *
 * `declaration` wins when a deployment somehow carries both, because that is the
 * model whose package is still maintained; the directory packages are inert
 * without a host that scans for them, so a stale copy proves nothing.
 */

import { dirname } from 'node:path'
import { parseNamedRows } from '../patch/patch.ts'
import { composeLayerTexts } from '../store/combo.ts'
import {
  DECLARATION_PLUGIN, DECLARATION_REGISTRY_PLUGIN, PRESET_PACKAGE, type PresetModel,
} from '../../../shared/preset.ts'
import type { ComposedLayer } from './declaration.ts'
import type { DshContext } from '../profile/appState.ts'

/**
 * A profile's patch layers, in application order, with the base each layer's
 * `.`-relative row resolves against.
 *
 * The base is the patch file's own directory: dsh extends a declaration's
 * context with the DECLARING row's base URL, so a `./tools/x.mjs` inside a
 * declaration resolves next to the file that declared it.
 * @param ctx - the dsh to read.
 * @param profile - the profile whose stack is read.
 * @returns one layer per patch file, in the order dsh applies them.
 */
export function profileLayers(ctx: DshContext, profile: string): ComposedLayer[] {
  return composeLayerTexts(ctx, profile).map(layer => ({
    kind: layer.source,
    text: layer.text,
    path: layer.path,
    baseDir: dirname(layer.path),
    ...(layer.bundle === undefined ? {} : { bundle: layer.bundle }),
  }))
}

/**
 * Which preset model these layers mount.
 * @param layers - a profile's patch layers.
 * @returns `declaration`, `directory`, or `none` when nothing mounts a roster.
 */
export function detectModel(layers: readonly ComposedLayer[]): PresetModel {
  let directory = false
  let declaration = false
  for (const layer of layers) {
    for (const row of parseNamedRows(layer.text)) {
      if (row.name === DECLARATION_PLUGIN || row.name === DECLARATION_REGISTRY_PLUGIN) declaration = true
      else if (row.name === PRESET_PACKAGE) directory = true
    }
  }
  if (declaration) return 'declaration'
  return directory ? 'directory' : 'none'
}
