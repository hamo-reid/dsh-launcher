/**
 * Line-level read/write of a `cordis.patch.yml` profile layer.
 *
 * Unlike a whole-file YAML dump, this edits only the target `disabled` line and
 * preserves every other line byte-for-byte — including comments and hand-written
 * rows (the lesson from earlier enable/disable work that re-dumped and lost them).
 */

import type { ClassifiedRow, PluginRow, RowCreateInput } from '../../../shared/types.ts'
import { dumpYaml, loadStructureOnly, type StructureParse } from './yaml.ts'

/** The patch layer's filename. The same in the home and profile layers, and the
 * name a bundle's `dsh.bundle.patch` falls back to when it declares none.
 *
 * It lives here, beside the editor for that file, because this module is a leaf
 * (it imports nothing else from `core`) — so every other module can name the file
 * without adding an edge to the graph. */
export const PATCH_FILE_NAME = 'cordis.patch.yml'

/** Matches a `- id: xxx` row start (optionally quoted id). */
const ID_RE = /^(\s*)- id:\s*'?([^'\s]+)'?\s*$/

/** Whether a line is a top-level (column-0) `[]` empty-array marker. A nested
 * `[]` value (e.g. `  config: []`) is indented and is NOT treated as one. */
function isTopLevelEmptyArray(line: string): boolean {
  return line.trim() === '[]' && line === line.trimStart()
}

/** A profile patch may carry a `[]` marker (the create template writes one, or a
 * row hand-added). Once real rows exist that marker is both meaningless and
 * invalid YAML — it forms a second top-level document. Strip such top-level
 * `[]` lines so appending rows replaces the empty overlay instead of sitting
 * beside it. Read-only parsing still sees the text as-is. */
function stripEmptyArrayMarker(text: string): string {
  return patchLines(text).filter(line => !isTopLevelEmptyArray(line)).join('\n')
}

/** Leading-space count of a line (0 for a column-0 line). */
function indentOf(line: string): number {
  return /^(\s*)/.exec(line)?.[1].length ?? 0
}

/**
 * The lines of a patch document, with the `\r` a CRLF file leaves on them removed.
 *
 * Every reader here matches a line's value with `(.*)$`, and in JavaScript `.`
 * does NOT match `\r` while `$` is the end of the input — so a trailing `\r` makes
 * the match fail outright instead of capturing one character too many. Measured on
 * a CRLF twin of a working declaration: `parseNamedRows` reported no `name` at all.
 * That is how a CRLF `cordis.patch.yml` ends up with an EMPTY preset roster, a
 * `disabled:` nothing can read, and an `insert:` list no reader sees — including
 * the duplicate-row pre-flight, which then passes a profile the host refuses to
 * boot.
 *
 * Writers assemble their output from these same lines, so editing a CRLF file
 * normalizes it to LF. Deliberate: this module owns the on-disk shape of the files
 * it edits, LF is what it already writes, and the alternative is every reader
 * carrying `\r` handling forever. Reads stay tolerant, so a file an editor hands
 * back as CRLF keeps working.
 */
function patchLines(text: string): string[] {
  return text.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/**
 * End (exclusive) of the block starting at `start` — the next `- ` row at the
 * SAME OR SHALLOWER indent, or EOF.
 *
 * Depth matters: a `- ` line nested deeper than the row is that row's own list
 * value (`args:` / `env:` entries, a group's nested rows), not a sibling. The
 * earlier indent-blind check truncated a row at its first list item, which broke
 * `extractKeyValue`/`removeRow` for any block-style list.
 */
function blockEnd(lines: string[], start: number): number {
  const rowIndent = indentOf(lines[start])
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (indentOf(line) <= rowIndent && /^\s*- /.test(line)) return i
  }
  return lines.length
}

/**
 * One DIRECT child key of a row: `{ line, value }`, or undefined.
 *
 * "Direct" is load-bearing, not tidiness. A row's `config` is an arbitrary
 * subtree, and a preset declaration's `config.plugins` is a list of plugin rows
 * carrying `disabled:` of their own — the shipped `standard` preset disables
 * several that way. An indent-blind scan reads the first of those as the
 * declaration's own `disabled: true` and hides the preset from the roster
 * entirely, so a row's own fields are read at its child indent and nowhere
 * deeper.
 */
function directChild(lines: string[], idIndex: number, key: string): { line: number; value: string } | undefined {
  const childIndent = indentOf(lines[idIndex]) + 2
  const head = new RegExp(`^${key}\\s*:\\s*(.*)$`)
  for (let i = idIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = indentOf(line)
    if (indent <= indentOf(lines[idIndex])) break
    if (indent !== childIndent) continue
    const m = head.exec(line.slice(childIndent))
    if (m !== null) return { line: i, value: m[1].trim() }
  }
  return undefined
}

/** Strip one pair of surrounding YAML quotes, leaving everything else as written. */
function unquote(value: string): string {
  const m = /^(['"])([\s\S]*)\1$/.exec(value)
  return m === null ? value : m[2]
}

/** The group plugin: an entry naming it owns an entry list in `config`, so the
 * walk descends into its children (`applyEntryPatches` inserts into it). */
const GROUP_PLUGIN = 'cordis:group'

/** One row a patch document carries: its `- id:` line, and whether THIS document
 * inserts it (rather than patching a row another layer inserted). */
interface PositionedRow {
  line: number
  id: string
  inserted: boolean
}

/** Index of the first non-blank, non-comment line at or after `from`. */
function nextContentLine(lines: string[], from: number): number | undefined {
  for (let i = from; i < lines.length; i++) {
    const text = lines[i].trim()
    if (text === '' || text.startsWith('#')) continue
    return i
  }
  return undefined
}

/** A key of the patch item or row starting at line `item`: the item's own line
 * when the key is spelled there (`- insert:`), else its direct child. */
function ownKey(lines: string[], item: number, key: string): { line: number; value: string } | undefined {
  const marker = new RegExp(`^(\\s*)-\\s*${key}\\s*:\\s*(.*)$`).exec(lines[item])
  if (marker !== null) return { line: item, value: marker[2].trim() }
  return directChild(lines, item, key)
}

/** The block sequence a key holds: its first item's line and that item's indent.
 * Undefined for an inline, empty (`key: []`) or non-sequence value. */
function sequenceOf(
  lines: string[], key: { line: number; value: string },
): { start: number; indent: number } | undefined {
  if (key.value !== '') return undefined
  const start = nextContentLine(lines, key.line + 1)
  if (start === undefined) return undefined
  const indent = indentOf(lines[start])
  if (indent <= indentOf(lines[key.line])) return undefined
  return /^\s*- /.test(lines[start]) ? { start, indent } : undefined
}

/** End (exclusive) of the sequence whose items sit at `indent`, from `start`. A
 * line at the item indent that is not itself an item closes the list. */
function sequenceEnd(lines: string[], start: number, indent: number): number {
  for (let i = start; i < lines.length; i++) {
    const text = lines[i].trim()
    if (text === '' || text.startsWith('#')) continue
    const at = indentOf(lines[i])
    if (at > indent) continue
    if (at === indent && /^\s*- /.test(lines[i])) continue
    return i
  }
  return lines.length
}

/** The entry list a group row owns by its `config` key, when it owns one. */
function groupConfigSequence(lines: string[], row: number): { start: number; indent: number } | undefined {
  const name = directChild(lines, row, 'name')?.value
  const isGroup = directChild(lines, row, 'group')?.value === 'true'
    || (name !== undefined && unquote(name) === GROUP_PLUGIN)
  if (!isGroup) return undefined
  const config = directChild(lines, row, 'config')
  return config === undefined ? undefined : sequenceOf(lines, config)
}

/** Collect one sequence's entries, in file order, descending into its groups. */
function collectEntries(
  lines: string[], sequence: { start: number; indent: number }, inserted: boolean, rows: PositionedRow[],
): void {
  const end = sequenceEnd(lines, sequence.start, sequence.indent)
  for (let i = sequence.start; i < end; i++) {
    const m = ID_RE.exec(lines[i])
    if (m === null || indentOf(lines[i]) !== sequence.indent) continue
    rows.push({ line: i, id: m[2], inserted })
    const children = groupConfigSequence(lines, i)
    if (children !== undefined) collectEntries(lines, children, inserted, rows)
  }
}

/**
 * Every row a patch document carries, in file order, each marked with whether the
 * document INSERTS it. This is the ONE definition of "a row" behind every reader
 * below — {@link parsePatchRows}, {@link parseNamedRows},
 * {@link parseClassifiedRows}, {@link collectInsertIds} and {@link findIdLine} —
 * because two answers to that question disagree in exactly the cases that matter.
 *
 * The walk follows the HOST'S patch structure, not the file's indentation, and
 * the difference is the point. `applyEntryPatches` builds entries from the
 * top-level patch list and the `insert:` lists it holds, plus the `config` list
 * of a GROUP entry; every other `config` is the plugin's private data. Since
 * 0.2.0-rc.1 the shipped `presets/*.patch.yml` files carry a whole plugin roster
 * inside an `@deepseek-ai/dsh-agent-preset` row, so an indent-blind read invents
 * ~100 loader entries no layer ever inserts — which then surface as phantom
 * duplicate-id boot conflicts and phantom plugins in the inventory.
 *
 * Top-level items are recognised at the document's own base indent (the first
 * `- ` line), so a patch file indented as a whole still reads.
 */
function positionedRows(lines: string[]): PositionedRow[] {
  const rows: PositionedRow[] = []
  let base = -1
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*- /.test(lines[i])) continue
    if (base < 0) base = indentOf(lines[i])
    if (indentOf(lines[i]) !== base) continue
    const m = ID_RE.exec(lines[i])
    if (m !== null) {
      rows.push({ line: i, id: m[2], inserted: false })
      const children = groupConfigSequence(lines, i)
      if (children !== undefined) collectEntries(lines, children, false, rows)
    }
    const insert = ownKey(lines, i, 'insert')
    if (insert === undefined) continue
    const sequence = sequenceOf(lines, insert)
    if (sequence !== undefined) collectEntries(lines, sequence, true, rows)
  }
  return rows
}

/** The line of the first ROW with this id — an entry, never a row nested in some
 * plugin's `config`. Editing by id must land on the row the host loads. */
function findIdLine(lines: string[], id: string): number | undefined {
  return positionedRows(lines).find(row => row.id === id)?.line
}

/** Parse every row the layer holds, and whether it is disabled. */
export function parsePatchRows(text: string): PluginRow[] {
  const lines = patchLines(text)
  return positionedRows(lines).map(row => ({
    id: row.id,
    disabled: directChild(lines, row.line, 'disabled')?.value === 'true',
  }))
}

/** A row with its package name (when the block carries one) and disabled state. */
interface NamedRow {
  id: string
  name?: string
  disabled: boolean
}

/**
 * Validate a fully-assembled patch document before it is written. A malformed
 * result (e.g. a row nested as a child of a scalar key) must never reach disk.
 * Files carrying cordis `!!js` tags skip the deep check so a custom tag is not
 * misread as bad YAML. Throws a friendly message.
 */
export function assertPatchDocValid(next: string): void {
  let check: StructureParse
  try {
    check = loadStructureOnly(next)
  } catch (error) {
    throw new Error(`patch 不是合法 YAML：${String(error instanceof Error ? error.message : error)}`)
  }
  // 只有注释 / 空文档由 js-yaml 5 自己拒绝（它抛 "expected a document"），已在上面
  // 的 catch 覆盖；`checked: false` 则意味着文档带 `!!js`，深度检查被跳过。
  if (!check.checked) return
  // dsh 要求 patch 顶层是 loader-patch 条目数组。对象、标量都会在启动时检查失败,
  // 必须在写入前拒绝——否则会静默写坏,到启动才暴露。
  if (!Array.isArray(check.value)) {
    throw new Error('patch 顶层必须是 YAML 数组（loader patch 条目列表）')
  }
}

/**
 * Collect the loader-entry ids a patch layer *inserts*: the rows of its top-level
 * `insert:` lists, and of the groups among those.
 *
 * `insert` is a PATCH key — `applyEntryPatches` reads it from the top-level patch
 * list alone — so an `insert:` key written on an entry is not a patch and its
 * children are not entries. Id-targeted rows patch a row another layer inserted
 * and may repeat across layers; only inserts create entries, so a repeated insert
 * id is exactly the host's duplicate-entry failure.
 */
export function collectInsertIds(text: string): string[] {
  return positionedRows(patchLines(text)).filter(row => row.inserted).map(row => row.id)
}

/** Parse rows including each block's `name:` (for bundle-built plugin rows). */
export function parseNamedRows(text: string): NamedRow[] {
  const lines = patchLines(text)
  return positionedRows(lines).map(row => {
    const name = directChild(lines, row.line, 'name')?.value
    return {
      id: row.id,
      name: name === undefined ? undefined : unquote(name),
      disabled: directChild(lines, row.line, 'disabled')?.value === 'true',
    }
  })
}

/**
 * Return a new `cordis.patch.yml` text with the named row's disabled state set.
 * Preserves all untouched lines. Idempotent: setting the same value is a no-op.
 */
export function setRowDisabled(text: string, id: string, disabled: boolean): string {
  text = stripEmptyArrayMarker(text)
  const lines = patchLines(text)
  const idIndex = findIdLine(lines, id)

  // ── no row yet: append a fresh block ────────────────────────────────
  if (idIndex === undefined) {
    const trimmed = text.trim()
    if (trimmed === '' || trimmed === '[]') {
      return disabled ? `- id: ${id}\n  disabled: true\n` : `- id: ${id}\n`
    }
    const addition = `- id: ${id}\n  disabled: ${disabled}`
    return text.endsWith('\n') ? text + addition + '\n' : `${text}\n${addition}\n`
  }

  const end = blockEnd(lines, idIndex)
  const indent = /^(\s*)/.exec(lines[idIndex])?.[1] ?? ''

  // Locate an existing `disabled:` line inside the block.
  let disabledLine = -1
  for (let j = idIndex + 1; j < end; j++) {
    if (/^\s*disabled:/.test(lines[j])) {
      disabledLine = j
      break
    }
  }

  if (disabled) {
    if (disabledLine >= 0) {
      const dIndent = /^(\s*)/.exec(lines[disabledLine])?.[1] ?? ''
      lines[disabledLine] = `${dIndent}disabled: true`
    } else {
      lines.splice(idIndex + 1, 0, `${indent}  disabled: true`)
    }
  } else {
    if (disabledLine >= 0) {
      lines.splice(disabledLine, 1)
      // If the block now holds nothing but comments/blank lines, drop the id row too.
      const newEnd = blockEnd(lines, idIndex)
      const bodyOnlyComments = lines.slice(idIndex + 1, newEnd).every(
        line => line.trim() === '' || line.trim().startsWith('#'),
      )
      if (bodyOnlyComments) lines.splice(idIndex, 1)
    }
    // else: no disabled line to remove — id already present and enabled.
  }

  return lines.join('\n')
}

/** Parse every row, classifying each block's shape (name/disabled/config/insert). */
export function parseClassifiedRows(text: string): ClassifiedRow[] {
  const lines = patchLines(text)
  return positionedRows(lines).map(row => {
    const name = directChild(lines, row.line, 'name')?.value
    return {
      id: row.id,
      name: name === undefined ? undefined : unquote(name),
      disabled: directChild(lines, row.line, 'disabled')?.value === 'true',
      hasConfig: directChild(lines, row.line, 'config') !== undefined,
      hasInsert: directChild(lines, row.line, 'insert') !== undefined,
    }
  })
}

/** Render the indented `config` key lines for a block's key indent. */
function renderConfig(indent: string, configText: string): string[] {
  const parts = configText.replace(/\s+$/, '').split('\n')
  if (parts.filter(p => p.trim() !== '').length <= 1 && !configText.includes('\n')) {
    return [`${indent}config: ${configText.trim()}`]
  }
  return [`${indent}config:`, ...parts.map(line => (line.trim() === '' ? '' : `${indent}  ${line}`))]
}

/** Render an `insert:` list block (empty items remove the key). */
function renderInsert(indent: string, items: string[]): string[] {
  if (items.length === 0) return []
  return [`${indent}insert:`, ...items.map(item => `${indent}  - ${item}`)]
}

/** Replace an existing key's block (key line + nested lines up to the next
 * same-or-less-indented line) with `render(indent)`. Returns whether it existed. */
function replaceKey(
  lines: string[], idIndex: number, key: string, render: (indent: string) => string[],
): boolean {
  const end = blockEnd(lines, idIndex)
  for (let j = idIndex + 1; j < end; j++) {
    if (!new RegExp(`^\\s*${key}\\s*:`).test(lines[j])) continue
    const keyIndent = /^(\s*)/.exec(lines[j])?.[1] ?? ''
    let remEnd = end
    for (let k = j + 1; k < end; k++) {
      const line = lines[k]
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      if ((/^(\s*)/.exec(line)?.[1] ?? '').length <= keyIndent.length) { remEnd = k; break }
    }
    lines.splice(j, remEnd - j, ...render(keyIndent))
    return true
  }
  return false
}

/** Append a key block to the end of the row's block. */
function appendKey(lines: string[], idIndex: number, render: (indent: string) => string[]): void {
  const end = blockEnd(lines, idIndex)
  const indent = /^(\s*)/.exec(lines[idIndex])?.[1] ?? ''
  lines.splice(end, 0, ...render(`${indent}  `))
}

/** Return a new patch text with the row's `config` key replaced by `configText`
 * (the value's YAML body). Throws when the row is absent — config always
 * targets an existing row. */
export function setRowConfig(text: string, id: string, configText: string): string {
  text = stripEmptyArrayMarker(text)
  const lines = patchLines(text)
  const idIndex = findIdLine(lines, id)
  if (idIndex === undefined) throw new Error(`row "${id}" not found`)
  const render = (indent: string): string[] => renderConfig(indent, configText)
  if (!replaceKey(lines, idIndex, 'config', render)) appendKey(lines, idIndex, render)
  return lines.join('\n')
}

/** Return a new patch text with the row's `insert` list set to `insertItems`
 * (each item its own `- …` entry). Creates the row block when absent. An empty
 * list removes the `insert` key. */
export function setRowInsert(text: string, id: string, insertItems: string[]): string {
  text = stripEmptyArrayMarker(text)
  const items = insertItems.map(item => item.trim()).filter(item => item !== '')
  const lines = patchLines(text)
  const idIndex = findIdLine(lines, id)
  const render = (indent: string): string[] => renderInsert(indent, items)
  if (idIndex === undefined) {
    // No such row yet: append a fresh block at the end.
    const tail = render('  ')
    const block = [`- id: ${id}`, ...tail].join('\n') + '\n'
    const sep = text === '' ? '' : (text.endsWith('\n') ? '' : '\n')
    return text === '' ? block : text + sep + block
  }
  if (!replaceKey(lines, idIndex, 'insert', render) && items.length > 0) {
    appendKey(lines, idIndex, render)
  }
  return lines.join('\n')
}

/** Build a fresh `- id:` block's text from the given fields. */
function buildRowBlock(patch: RowCreateInput): string {
  const lines = [`- id: ${patch.id}`]
  if (patch.disabled !== undefined) lines.push(`  disabled: ${patch.disabled}`)
  if (patch.config !== undefined && patch.config.trim() !== '') {
    lines.push(...renderConfig('  ', patch.config))
  } else if (patch.insert !== undefined && patch.insert.length > 0) {
    lines.push(...renderInsert('  ', patch.insert))
  }
  return lines.join('\n')
}

/** Append a raw row block to the end of a patch document, replacing a leading
 * `[]` empty-overlay marker so the result is a single top-level list. */
export function appendRowBlock(text: string, block: string): string {
  const base = stripEmptyArrayMarker(text)
  if (base === '') return `${block}\n`
  return base.endsWith('\n') ? base + block + '\n' : `${base}\n${block}\n`
}

/** Upsert a row in the patch: create the block when absent, otherwise merge the
 * given fields in (disabled/config/insert each edited independently). */
export function upsertRow(text: string, patch: RowCreateInput): string {
  text = stripEmptyArrayMarker(text)
  const lines = patchLines(text)
  if (findIdLine(lines, patch.id) === undefined) {
    return appendRowBlock(text, buildRowBlock(patch))
  }
  let out = text
  if (patch.disabled !== undefined) out = setRowDisabled(out, patch.id, patch.disabled)
  if (patch.config !== undefined) out = setRowConfig(out, patch.id, patch.config)
  if (patch.insert !== undefined) out = setRowInsert(out, patch.id, patch.insert)
  return out
}

/** Remove one entire row block (`- id:` through the next row / EOF). A no-op
 * when the row does not exist. All other lines are preserved. */
export function removeRow(text: string, id: string): string {
  text = stripEmptyArrayMarker(text)
  const lines = patchLines(text)
  const idx = findIdLine(lines, id)
  if (idx === undefined) return text
  lines.splice(idx, blockEnd(lines, idx) - idx)
  return lines.join('\n')
}

/** The `- insert:` line that owns a nested row: the nearest preceding line with a
 * shallower indent, when that line is an insert header. `undefined` when the row
 * is top-level or its owner is some other key (a group's `config:`). */
function findInsertHeader(lines: string[], rowIndex: number): number | undefined {
  const rowIndent = indentOf(lines[rowIndex])
  for (let i = rowIndex - 1; i >= 0; i--) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (indentOf(line) >= rowIndent) continue
    return /^(\s*)- insert\s*:\s*$/.test(line) ? i : undefined
  }
  return undefined
}

/** End (exclusive) of the block owned by a key line: the next non-blank,
 * non-comment line at the same or a shallower indent. */
function blockEndByIndent(lines: string[], start: number): number {
  const indent = indentOf(lines[start])
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (indentOf(line) <= indent) return i
  }
  return lines.length
}

/**
 * Append one child row (object form; `childLines` already carry their 4-space
 * base indent) to the document's top-level `- insert:` list, creating that block
 * when absent. Reuses an existing block so repeated adds keep one tidy list.
 */
export function appendInsertChild(text: string, childLines: string[]): string {
  const base = stripEmptyArrayMarker(text)
  const lines = patchLines(base)
  const header = lines.findIndex(line => /^- insert\s*:\s*$/.test(line))
  if (header < 0) {
    const body = ['- insert:', ...childLines].join('\n') + '\n'
    if (base.trim() === '') return body
    return base.endsWith('\n') ? base + body : `${base}\n${body}`
  }
  // Sit with the siblings: step back over the blank lines that trail the block.
  let at = blockEndByIndent(lines, header)
  while (at > header + 1 && lines[at - 1].trim() === '') at--
  lines.splice(at, 0, ...childLines)
  return lines.join('\n')
}

/**
 * Remove one row nested under an `insert:` key, dropping the owning `- insert:`
 * block when it was the last child — an `insert:` with no children is a null
 * value, which is not a valid loader patch list. A top-level row is delegated to
 * {@link removeRow}.
 */
export function removeInsertRow(text: string, id: string): string {
  const base = stripEmptyArrayMarker(text)
  const lines = patchLines(base)
  const idx = findIdLine(lines, id)
  if (idx === undefined) return base
  if (indentOf(lines[idx]) === 0) return removeRow(base, id)
  const header = findInsertHeader(lines, idx)
  lines.splice(idx, blockEnd(lines, idx) - idx)
  if (header === undefined) return lines.join('\n')
  const end = blockEndByIndent(lines, header)
  const hasChild = lines.slice(header + 1, end).some(line => /^\s+- /.test(line))
  if (!hasChild) lines.splice(header, end - header)
  return lines.join('\n')
}

/** Extract a row block's verbatim text (its `- id:` line + child keys). */
export function extractRowBlock(text: string, id: string): string | undefined {
  const lines = patchLines(text)
  const idx = findIdLine(lines, id)
  if (idx === undefined) return undefined
  return lines.slice(idx, blockEnd(lines, idx)).join('\n')
}

/** Extract the value text of a named key (`config`, `name`, …) within a row's
 * block. Returns the scalar value for `config: {}`/`config: str`, or the
 * sub-block text (with the key's 2-space nesting stripped) for a block form.
 * `undefined` when the row or key is absent. */
export function extractKeyValue(text: string, id: string, key: string): string | undefined {
  const lines = patchLines(text)
  const idx = findIdLine(lines, id)
  if (idx === undefined) return undefined
  const end = blockEnd(lines, idx)
  const head = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`)
  for (let j = idx + 1; j < end; j++) {
    const m = head.exec(lines[j])
    if (m === null) continue
    const inline = m[1].trim()
    if (inline !== '') return inline
    const keyIndent = /^(\s*)/.exec(lines[j])?.[1] ?? ''
    const collected: string[] = []
    for (let k = j + 1; k < end; k++) {
      const line = lines[k]
      if (line.trim() === '') { collected.push(''); continue }
      const ind = /^(\s*)/.exec(line)?.[1] ?? ''
      if (ind.length <= keyIndent.length) break
      collected.push(line.replace(new RegExp(`^\\s{${keyIndent.length + 2}}`), ''))
    }
    return collected.join('\n')
  }
  return undefined
}

/**
 * The `config:` key line of a row block and the indent its children sit at.
 *
 * `undefined` when the row carries no `config` key or spells it inline
 * (`config: {...}`), which is no line a scalar edit could touch.
 */
function configKeyLine(lines: string[], idIndex: number): { line: number; childIndent: string } | undefined {
  const end = blockEnd(lines, idIndex)
  for (let j = idIndex + 1; j < end; j++) {
    const m = /^(\s*)config\s*:\s*(.*)$/.exec(lines[j])
    if (m === null) continue
    if (m[2].trim() !== '') return undefined
    return { line: j, childIndent: `${m[1]}  ` }
  }
  return undefined
}

/**
 * Set (or clear) one scalar key INSIDE a row's `config` block, touching nothing
 * else in the block.
 *
 * This exists because a declaration's `config` carries more than scalars: a
 * preset's `plugins` list may hold `!!js` gates and `|` block scalars, and
 * re-rendering the whole `config` (what {@link setRowConfig} does) would destroy
 * both — `!!js` survives js-yaml only as a private sentinel that must never be
 * dumped. Editing the one line leaves every other byte of the block alone.
 *
 * A `value` of `undefined` (or a whitespace-only string) REMOVES the key rather
 * than writing it empty: the host's schemas declare these fields optional, and
 * `name:` with no value is `null`, which is not a string.
 * @param text - the patch document.
 * @param id - the row's loader id.
 * @param key - the scalar key to set (`name`, `description`, `order`, …).
 * @param value - the value, or `undefined`/`''` to drop the key.
 * @returns the new patch text.
 */
export function setConfigScalar(
  text: string, id: string, key: string, value: string | number | undefined,
): string {
  const lines = patchLines(text)
  const idIndex = findIdLine(lines, id)
  if (idIndex === undefined) throw new Error(`row "${id}" not found`)
  const config = configKeyLine(lines, idIndex)
  if (config === undefined) throw new Error(`row "${id}" has no block-form config to edit`)
  const end = blockEnd(lines, idIndex)
  const head = new RegExp(`^${config.childIndent}${key}\\s*:`)
  let at = -1
  for (let j = config.line + 1; j < end; j++) {
    const line = lines[j]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (indentOf(line) <= indentOf(lines[config.line])) break
    if (head.test(line)) {
      at = j
      break
    }
  }
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
    if (at >= 0) lines.splice(at, 1)
    return lines.join('\n')
  }
  // Rendered through the shared dumper, so a value carrying `:`, `#`, a newline
  // or a leading space is quoted/blocked the way YAML requires instead of
  // silently changing meaning.
  const rendered = dumpYaml({ [key]: value }).trimEnd().split('\n')
    .map(line => `${config.childIndent}${line}`)
  if (at >= 0) {
    lines.splice(at, 1, ...rendered)
    return lines.join('\n')
  }
  // A new key sits right after `id:` when the config carries one — the order a
  // preset declaration reads in — else at the top of the block.
  let insertAt = config.line + 1
  const idChild = new RegExp(`^${config.childIndent}id\\s*:`)
  for (let j = config.line + 1; j < end; j++) {
    if (idChild.test(lines[j])) {
      insertAt = j + 1
      break
    }
  }
  lines.splice(insertAt, 0, ...rendered)
  return lines.join('\n')
}