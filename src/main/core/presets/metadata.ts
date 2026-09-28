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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { METADATA_FILE } from '../../../shared/preset.ts'
import { dumpYaml, isJsExpr, loadYaml } from '../patch/yaml.ts'
import type { PresetMetaInput } from '../../../shared/types.ts'

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

/**
 * Render display metadata as the file's contents.
 *
 * Absent fields are omitted rather than written empty, so a preset with no
 * description does not ship a key that reads as an intentional blank, and a
 * preset with nothing to publish has no file at all.
 * @param meta - the display text to store.
 * @returns the YAML document, or undefined when there is nothing to store.
 */
export function renderPresetMetadata(meta: PresetMetaInput): string | undefined {
  const name = text(meta.name)
  const description = text(meta.description)
  const order = typeof meta.order === 'number' && Number.isFinite(meta.order) ? meta.order : undefined
  if (name === undefined && description === undefined && order === undefined) return undefined
  return dumpYaml({
    ...name === undefined ? {} : { name },
    ...description === undefined ? {} : { description },
    ...order === undefined ? {} : { order },
  })
}

/**
 * Store one preset's display metadata.
 *
 * Nothing to publish removes the file: an empty `preset.yml` would claim the
 * preset publishes blank text, where its absence says it publishes none.
 * @param dir - the preset directory to write into.
 * @param meta - the display text to store.
 */
export function writePresetMetadata(dir: string, meta: PresetMetaInput): void {
  const rendered = renderPresetMetadata(meta)
  const path = join(dir, METADATA_FILE)
  if (rendered === undefined) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, rendered)
  if (readFileSync(path, 'utf8') !== rendered) throw new Error('write verify failed')
}
