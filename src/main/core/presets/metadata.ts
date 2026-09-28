/**
 * A preset's display metadata: the `preset.yml` beside its composition.
 *
 * It lives in its own file because a composition is a top-level list of plugin
 * rows — YAML cannot carry sibling keys beside it — and because the composition
 * stays exactly what its name says: a Cordis file the loader owns. The file
 * therefore carries display text ONLY: `id` is the directory name and `trust`
 * comes from the root a preset was discovered under, so neither is writable
 * here, or a locally authored preset could claim to be a built-in one.
 *
 * Every read failure degrades to no metadata. A preset whose display text is
 * missing, malformed, or unreadable still mounts: presentation is not a
 * capability, and a broken name must never become a preset that cannot start.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { METADATA_FILE } from '../../../shared/preset.ts'
import { isJsExpr, loadYaml } from '../patch/yaml.ts'

/** Display text a preset may publish about itself. */
export interface PresetMetadata {
  /** Human-facing name; falls back to the preset id when absent. */
  name?: string
  /** One sentence on what this preset is for. */
  description?: string
  /** Position within its own root's group; lower comes first. */
  order?: number
}

/** A non-empty trimmed string, or undefined for anything else. A `!!js`
 * expression is not display text: the host's own metadata read cannot even
 * parse the tag, so it publishes nothing rather than an unevaluated source. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || isJsExpr(value)) return undefined
  return trimmed
}

/**
 * Read one preset directory's display metadata.
 *
 * Absent, unparsable, and wrongly-shaped files are all the same answer — empty
 * metadata — because the caller renders a list, not a diagnostic.
 * @param dir - the preset directory.
 * @returns the display text the preset published, possibly empty.
 */
export function readPresetMetadata(dir: string): PresetMetadata {
  let raw: string
  try {
    raw = readFileSync(join(dir, METADATA_FILE), 'utf8')
  } catch {
    // Absent is the common case: metadata is optional, and every preset authored
    // by duplicating another carries whatever its source carried.
    return {}
  }
  let parsed: unknown
  try {
    parsed = loadYaml(raw)
  } catch {
    // Malformed display text is not worth failing discovery over: the row falls
    // back to the id, and the composition still mounts.
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  const name = text(record.name)
  const description = text(record.description)
  const order = typeof record.order === 'number' && Number.isFinite(record.order)
    ? record.order
    : undefined
  return {
    ...name === undefined ? {} : { name },
    ...description === undefined ? {} : { description },
    ...order === undefined ? {} : { order },
  }
}
