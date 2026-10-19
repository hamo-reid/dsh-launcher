/**
 * A preset composition's rows, read the way the host reads them.
 *
 * `agent.cordis.yml` is a top-level list of plugin rows: each row names the
 * module to load (`name`), may carry an `id`, and may be a `group: true` row
 * whose `config` is a nested list. The host judges a composition in two passes
 * — shape first (`entryListProblem`), then, for the rows that would actually
 * start, whether the named module resolves (`unresolvableRows`) — and this
 * module reproduces both, because a launcher-side verdict that disagreed with
 * the mount would be worse than no verdict at all.
 *
 * Two host decisions are load-bearing here and are copied deliberately:
 *
 * - A row starts unless `Boolean(disabled)` is truthy, so `disabled: 0` is a
 *   row that DOES start and a `!!js` gate (parsed to a non-empty string) is one
 *   that cannot be decided without the loader — the latter is reported as
 *   `conditional` and never as a missing module.
 * - A `!!js` `name` is the same case: only the loader can evaluate it.
 */

import { isAbsolute } from 'node:path'
import { isJsExpr, loadYaml } from '../patch/yaml.ts'
import type { PresetRowKind } from '../../../shared/preset.ts'

/** Where one row's `name` reaches a module. The union lives in shared/preset.ts:
 * the renderer labels these rows and may not import from main, so aliasing it
 * here keeps one definition of what a row's specifier can mean. */
export type RowKind = PresetRowKind

/** One composition row worth judging. */
export interface CompositionRow {
  /** `row "id"`, else `row N` — the host's own wording, nesting included. */
  label: string
  /** The specifier exactly as the row wrote it. */
  name: string
  kind: RowKind
  /** `disabled:` is truthy, so the host would not start this row. */
  skipped: boolean
  /** The specifier is a `!!js` expression only the loader can decide. */
  conditional: boolean
}

/** A composition read: the rows to judge, or why the file cannot be loaded. */
export type CompositionRead =
  | { ok: true; rows: CompositionRow[] }
  | { ok: false; problem: string }

/**
 * Classify one row's `name`, exactly as the host's `classifyRowSpecifier` does.
 *
 * An absolute filesystem path is a `file` row: Node's ESM resolver rejects a
 * bare drive-letter path on Windows, and the Loader accepts both spellings of
 * the same thing.
 *
 * A `file:` specifier is a `file` row too, and — measured against the
 * 0.2.0-rc.1 host — it is an ABSOLUTE URL in every relative-looking spelling:
 * the Loader hands it to Node's ESM resolver as a URL, and that resolver never
 * anchors a URL-carrying specifier to the importing tree. `file:./x.mjs` beside
 * the declaring patch file therefore does NOT reach that file: on Windows the
 * host refuses the row outright ("File URL path must be absolute"), and on
 * POSIX the specifier collapses to the filesystem root. So the row judgement
 * must not treat it as base-relative either — a preset that means "the file next
 * to me" writes `./x.mjs` (which the host DOES anchor, per patch file), and the
 * `file:` form is for an absolute location only. See docs/presets.md section 4.3.
 * @param name - the specifier exactly as the row wrote it.
 * @returns which base the specifier belongs to.
 */
export function classifyRowSpecifier(name: string): RowKind {
  if (name.startsWith('cordis:')) return 'builtin'
  if (name.startsWith('.')) return 'preset'
  if (name.startsWith('file:')) return 'file'
  if (isAbsolute(name)) return 'file'
  return 'package'
}

/**
 * Why the parsed composition cannot mount, or undefined when its shape holds.
 *
 * A shallow check, deliberately short of the loader's work: it does not resolve
 * plugin names or apply configs, only rejects what the loader cannot even begin
 * with. It must accept everything the loader accepts, which is why a row is
 * required to be nothing more than a map carrying a `name`.
 * @param rows - the parsed composition document.
 * @param at - row-path prefix for nested diagnostics, empty at the top level.
 * @returns one human-readable reason, or undefined when the shape holds.
 */
function shapeProblem(rows: unknown, at = ''): string | undefined {
  if (!Array.isArray(rows)) {
    return at === ''
      ? 'the composition must be a top-level list of plugin rows'
      : `group ${at} must hold a list of plugin rows`
  }
  for (const [index, row] of rows.entries()) {
    const label = at === '' ? `row ${String(index + 1)}` : `${at} row ${String(index + 1)}`
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return `${label} is not a plugin row (expected a map with a "name")`
    }
    const { name, group, config } = row as { name?: unknown; group?: unknown; config?: unknown }
    if (typeof name !== 'string' || name === '') {
      return `${label} names no plugin (a "name" string is required)`
    }
    if (group === true) {
      const nested = shapeProblem(config, label)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Flatten the rows the host would judge. Shape is the caller's precondition:
 * {@link shapeProblem} has already proven every row is a map carrying a `name`,
 * and groups recurse the same way it does.
 * @param rows - the parsed composition rows.
 * @param at - row-path prefix for nested labels, empty at the top level.
 * @param out - the list the rows are appended to, in composition order.
 */
function collect(rows: readonly unknown[], at: string, out: CompositionRow[]): void {
  for (const [index, entry] of rows.entries()) {
    const row = entry as {
      id?: unknown; name: string; group?: unknown; config?: unknown; disabled?: unknown
    }
    const positional = at === '' ? `row ${String(index + 1)}` : `${at} row ${String(index + 1)}`
    if (row.group === true) {
      collect(row.config as readonly unknown[], positional, out)
      continue
    }
    const name = row.name.trim()
    out.push({
      label: typeof row.id === 'string' && row.id !== '' ? `row "${row.id}"` : positional,
      name,
      kind: classifyRowSpecifier(name),
      skipped: Boolean(row.disabled),
      conditional: isJsExpr(name),
    })
  }
}

/**
 * Judge an ALREADY-PARSED composition value: the row list a declaration's
 * `config.plugins` and a whole `agent.cordis.yml` are judged by the same code,
 * so the two preset models cannot disagree about what a row means.
 * @param parsed - the parsed document, already carrying `!!js` as its sentinel.
 * @returns the rows, or the reason the value cannot mount.
 */
export function readCompositionValue(parsed: unknown): CompositionRead {
  const problem = shapeProblem(parsed)
  if (problem !== undefined) return { ok: false, problem }
  const rows: CompositionRow[] = []
  collect(parsed as readonly unknown[], '', rows)
  return { ok: true, rows }
}

/**
 * Read one composition's rows from its text.
 *
 * Parsed with the launcher's shared tolerant schema (`CONFIG_SCHEMA`, the one
 * carrying `!!js`), so a composition the loader accepts is never reported as
 * unparsable here.
 * @param text - the composition file's contents.
 * @returns the rows, or the reason the file cannot be loaded.
 */
export function readComposition(text: string): CompositionRead {
  let parsed: unknown
  try {
    parsed = loadYaml(text)
  } catch (error) {
    const full = error instanceof Error ? error.message : String(error)
    // First line only: js-yaml appends a multi-line code-frame snippet, and the
    // reason is displayed on a list row, not in a terminal.
    return { ok: false, problem: `the composition is not valid YAML: ${full.replace(/\n[\s\S]*$/, '')}` }
  }
  return readCompositionValue(parsed)
}
