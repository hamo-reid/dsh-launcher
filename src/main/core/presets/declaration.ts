/**
 * The declaration model: a preset is a ROW of `@deepseek-ai/dsh-agent-preset`
 * in an ordinary Cordis patch layer (dsh 0.2.0-rc.1 and later).
 *
 * Three host facts shape everything here, and each one is why this is not the
 * directory model with a different reader:
 *
 * - Definitions are ordinary plugin rows, so the roster comes from the SAME
 *   patch stack a launch composes: bundle layers, then the profile's own layer,
 *   then the machine-level home layer. There is no directory to scan and no
 *   `trust` — where a row sits IS its provenance, and only the profile and home
 *   layers are ours to write.
 * - A patch keyed by a loader row id replaces that row's WHOLE `config`, and an
 *   `insert` adds a new row; either way the effective definition of a row id is
 *   what the LAST layer said. That fold is {@link readDeclarations}.
 * - `config.plugins` is real composition text that may carry `!!js` gates and
 *   `|` block scalars. Nothing here re-renders it: a copy slices the block
 *   verbatim and a metadata edit touches only the scalar lines beside it.
 */

import { dumpYaml, isJsExpr, loadYaml } from '../patch/yaml.ts'
import {
  appendInsertChild, extractKeyValue, parseClassifiedRows, removeInsertRow, setConfigScalar,
} from '../patch/patch.ts'
import { readCompositionValue, type CompositionRead } from './rows.ts'
import { DECLARATION_PLUGIN } from '../../../shared/preset.ts'
import type { PresetMetaInput } from '../../../shared/types.ts'

/** One patch layer of a profile's composition, as the host applies it. */
export interface ComposedLayer {
  /** Which layer this is: a bundle layer, the profile's own, or the machine-level one. */
  kind: 'bundle' | 'profile' | 'home'
  /** The layer's patch file text. */
  text: string
  /** Absolute path of that patch file — what an "open" action reveals. */
  path: string
  /** Base a `.`-relative row in this layer resolves against (the patch file's dir). */
  baseDir: string
  /** The bundle package name, on a bundle layer. */
  bundle?: string
}

/** One preset a layer stack declares. */
export interface DeclaredPreset {
  /** Preset identity — the row's `config.id`, never the loader row id. */
  id: string
  /** Loader row id carrying the definition; this is what a patch targets. */
  rowId: string
  layer: ComposedLayer['kind']
  bundle?: string
  /** The layer's patch file the definition came from. */
  sourcePath: string
  /** `.`-relative row base for this declaration. */
  baseDir: string
  name?: string
  description?: string
  order?: number
  /** Parsed `config.plugins`, kept for the row judgement. */
  plugins: unknown
  /** Value-level read of `plugins`, shared with the directory model. */
  read: CompositionRead
  /** Why the declaration cannot activate, when it can't. */
  broken?: string
}

/** The roster a layer stack resolves to, plus what could not be shown as a row. */
export interface DeclarationRead {
  presets: DeclaredPreset[]
  /** Roster-level diagnostics: a definition dsh takes but the page cannot list. */
  warnings: string[]
}

/** The definition a fold keeps per loader row id. */
interface Pending {
  layer: ComposedLayer
  /** The parsed `config`, or a marker that it could not be parsed. */
  config: unknown
}

/** A key the fold plants when a `config` body will not parse. */
const UNPARSABLE = '__launcherUnparsableConfig'

/** Whether a value is a `!!js` sentinel — undecidable here, the loader's own. */
function isJs(value: unknown): boolean {
  return isJsExpr(value) === true
}

/** A scalar the host's schema would reject: decidable AND the wrong type. */
function badScalar(value: unknown, kind: 'string' | 'number'): boolean {
  if (value === undefined || isJs(value)) return false
  return kind === 'string'
    ? typeof value !== 'string'
    : typeof value !== 'number' || !Number.isFinite(value)
}

/** Read one accepted `config` value into the row the page renders. */
function toPreset(rowId: string, layer: ComposedLayer, config: Record<string, unknown>): DeclaredPreset {
  const raw = config.id
  const identity = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : rowId
  const read = readCompositionValue(config.plugins)
  const base: DeclaredPreset = {
    id: identity,
    rowId,
    layer: layer.kind,
    sourcePath: layer.path,
    baseDir: layer.baseDir,
    plugins: config.plugins,
    read,
    ...(layer.bundle === undefined ? {} : { bundle: layer.bundle }),
    ...(typeof config.name === 'string' && config.name !== '' ? { name: config.name } : {}),
    ...(typeof config.description === 'string' && config.description !== ''
      ? { description: config.description } : {}),
    ...(typeof config.order === 'number' && Number.isFinite(config.order) ? { order: config.order } : {}),
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ...base, broken: 'the declaration names no preset id (`config.id`)' }
  }
  if (badScalar(config.name, 'string')) return { ...base, broken: 'invalid config: `name` is not a string' }
  if (badScalar(config.description, 'string')) {
    return { ...base, broken: 'invalid config: `description` is not a string' }
  }
  if (badScalar(config.order, 'number')) return { ...base, broken: 'invalid config: `order` is not a number' }
  if (!read.ok) return { ...base, broken: read.problem }
  return base
}

/** A declaration row that could not be read as a config at all. */
function unreadable(rowId: string, layer: ComposedLayer, broken: string): DeclaredPreset {
  return {
    id: rowId,
    rowId,
    layer: layer.kind,
    sourcePath: layer.path,
    baseDir: layer.baseDir,
    plugins: undefined,
    read: { ok: false, problem: broken },
    broken,
    ...(layer.bundle === undefined ? {} : { bundle: layer.bundle }),
  }
}

/**
 * Fold a profile's patch layers into its preset roster, the way the host does.
 *
 * A row naming {@link DECLARATION_PLUGIN} defines (or replaces) the definition
 * of its loader row id; any row naming that id sets its `disabled` — the shape a
 * later layer uses to switch a declaration off — and the LAST one wins, which is
 * what "the entry's field ends up as the last layer wrote it" means. Two rows
 * declaring one PRESET id are the host's `Duplicate agent preset` failure: the
 * earlier wins, exactly as the registry's first-registration-wins rule, and the
 * loser is reported rather than silently dropped.
 * @param layers - the profile's patch layers, in application order.
 * @returns the roster in declaration order, plus roster-level warnings.
 */
export function readDeclarations(layers: readonly ComposedLayer[]): DeclarationRead {
  const definitions = new Map<string, Pending>()
  const disabled = new Map<string, boolean>()
  const order: string[] = []
  for (const layer of layers) {
    for (const row of parseClassifiedRows(layer.text)) {
      disabled.set(row.id, row.disabled)
      if (row.name !== DECLARATION_PLUGIN) continue
      const body = extractKeyValue(layer.text, row.id, 'config')
      let config: unknown
      if (body === undefined || body.trim() === '') {
        config = undefined
      } else {
        try {
          config = loadYaml(body)
        } catch (error) {
          config = { [UNPARSABLE]: error instanceof Error ? error.message : String(error) }
        }
      }
      if (!definitions.has(row.id)) order.push(row.id)
      definitions.set(row.id, { layer, config })
    }
  }

  const presets: DeclaredPreset[] = []
  const warnings: string[] = []
  const byId = new Map<string, DeclaredPreset>()
  for (const rowId of order) {
    if (disabled.get(rowId) === true) continue
    const pending = definitions.get(rowId) as Pending
    const config = pending.config
    let preset: DeclaredPreset
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      preset = unreadable(rowId, pending.layer, 'the declaration carries no `config` map')
    } else if (typeof (config as Record<string, unknown>)[UNPARSABLE] === 'string') {
      preset = unreadable(rowId, pending.layer, String((config as Record<string, unknown>)[UNPARSABLE]))
    } else {
      preset = toPreset(rowId, pending.layer, config as Record<string, unknown>)
    }
    const first = byId.get(preset.id)
    if (first === undefined) {
      byId.set(preset.id, preset)
      presets.push(preset)
      continue
    }
    warnings.push(
      `preset "${preset.id}" is declared twice — ${first.sourcePath} wins, ${preset.sourcePath} cannot activate (dsh reports "Duplicate agent preset: ${preset.id}")`,
    )
  }
  presets.sort((left, right) => (left.order ?? Number.POSITIVE_INFINITY)
    - (right.order ?? Number.POSITIVE_INFINITY) || left.id.localeCompare(right.id))
  return { presets, warnings }
}

/**
 * The loader row id the launcher writes for a preset it creates.
 *
 * Deliberately NOT the shipped `preset-<id>` convention: a repeated loader row
 * id makes dsh refuse to boot the whole profile, while a repeated PRESET id only
 * fails that one declaration — so the launcher's rows keep a namespace of their
 * own, and a future shipped preset reusing the id degrades to one broken row
 * instead of an unbootable profile.
 * @param id - the preset id.
 * @returns the loader row id to declare it under.
 */
export function declarationLoaderId(id: string): string {
  return `local-preset-${id}`
}

/** One bare scalar rendered the way YAML requires (quoted when it must be). */
function quoted(value: string): string {
  return dumpYaml(value).trimEnd()
}

/** One `key: value` line of a config body. */
function scalarLine(key: string, value: string | number): string {
  return `${key}: ${typeof value === 'number' ? String(value) : quoted(value)}`
}

/**
 * The `plugins:` block of a `config` body, verbatim, or undefined when it
 * carries none.
 * @param configBody - a config body as {@link configBodyOf} returns it.
 * @returns the block, or undefined.
 */
export function pluginsBlockOf(configBody: string): string | undefined {
  const lines = configBody.split('\n')
  const start = lines.findIndex(line => /^plugins\s*:/.test(line))
  if (start < 0) return undefined
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    // A block scalar's content and every nested row are indented, so the next
    // column-0 line is the next top-level key of the config body.
    if (lines[i].trim() !== '' && /^\S/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n').trimEnd()
}

/** Indent every non-blank line of a block by `spaces`. */
function reindent(block: string, spaces: number): string[] {
  const pad = ' '.repeat(spaces)
  return block.split('\n').map(line => (line.trim() === '' ? '' : `${pad}${line}`))
}

/** The fields a new declaration row is rendered from. */
export interface DeclarationInput {
  id: string
  name?: string
  description?: string
  order?: number
  /** The source declaration's `plugins:` block, copied verbatim. */
  pluginsBlock: string
}

/**
 * Render one whole declaration row as `insert:` child lines (4-space base
 * indent), ready for {@link insertDeclaration}.
 *
 * The `plugins:` block is copied line for line: a copy has to stay exactly as
 * loadable as its source, and re-rendering it would drop `!!js` gates and
 * reshape block scalars.
 * @param input - identity, display text and the source plugin block.
 * @returns the row's lines, already indented for `appendInsertChild`.
 */
export function renderDeclarationRow(input: DeclarationInput): string[] {
  const body: string[] = [scalarLine('id', input.id)]
  if (input.name !== undefined && input.name.trim() !== '') body.push(scalarLine('name', input.name))
  if (input.description !== undefined && input.description.trim() !== '') {
    body.push(scalarLine('description', input.description))
  }
  if (input.order !== undefined) body.push(scalarLine('order', input.order))
  body.push(...input.pluginsBlock.split('\n'))
  return [
    `    - id: ${declarationLoaderId(input.id)}`,
    `      name: ${quoted(DECLARATION_PLUGIN)}`,
    '      config:',
    ...reindent(body.join('\n'), 8),
  ]
}

/** Add a new declaration row to a patch layer. */
export function insertDeclaration(text: string, input: DeclarationInput): string {
  return appendInsertChild(text, renderDeclarationRow(input))
}

/** Remove one declaration row; its owning `insert:` block goes with it when it
 * was the last child. */
export function removeDeclaration(text: string, rowId: string): string {
  return removeInsertRow(text, rowId)
}

/**
 * Store a declaration's display metadata, touching only the scalar lines inside
 * its `config` block. The `plugins` list — and every comment around it — is left
 * byte-for-byte as it was.
 * @param text - the patch document.
 * @param rowId - the declaration's loader row id.
 * @param meta - the display half; `''`/`null` clears a key.
 * @returns the new patch text.
 */
export function saveDeclarationMeta(text: string, rowId: string, meta: PresetMetaInput): string {
  let out = setConfigScalar(text, rowId, 'name', meta.name)
  out = setConfigScalar(out, rowId, 'description', meta.description)
  out = setConfigScalar(out, rowId, 'order', meta.order ?? undefined)
  return out
}

/** The `config` body text of one declaration row, for copying its plugins. */
export function configBodyOf(text: string, rowId: string): string | undefined {
  return extractKeyValue(text, rowId, 'config')
}
