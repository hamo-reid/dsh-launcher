/**
 * Line-level read/write of a `cordis.patch.yml` profile layer.
 *
 * Unlike a whole-file YAML dump, this edits only the target `disabled` line and
 * preserves every other line byte-for-byte — including comments and hand-written
 * rows (the lesson from earlier enable/disable work that re-dumped and lost them).
 */

import type { ClassifiedRow, PluginRow, RowCreateInput } from '../../../shared/types.ts'
import { loadStructureOnly, type StructureParse } from './yaml.ts'

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
  return text.split('\n').filter(line => !isTopLevelEmptyArray(line)).join('\n')
}

function findIdLine(lines: string[], id: string): number | undefined {
  for (let i = 0; i < lines.length; i++) {
    const m = ID_RE.exec(lines[i])
    if (m !== null && m[2] === id) return i
  }
  return undefined
}

/** Leading-space count of a line (0 for a column-0 line). */
function indentOf(line: string): number {
  return /^(\s*)/.exec(line)?.[1].length ?? 0
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

/** Parse every `- id:` row and whether it is disabled. */
export function parsePatchRows(text: string): PluginRow[] {
  const lines = text.split('\n')
  const rows: PluginRow[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = ID_RE.exec(lines[i])
    if (m === null) continue
    const end = blockEnd(lines, i)
    let disabled = false
    for (let j = i + 1; j < end; j++) {
      const d = /\bdisabled:\s*(true|false)/.exec(lines[j])
      if (d !== null) {
        disabled = d[1] === 'true'
        break
      }
    }
    rows.push({ id: m[2], disabled })
  }
  return rows
}

/** A row with its package name (when the block carries one) and disabled state. */
export interface NamedRow {
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
 * Collect the loader-entry ids a patch layer *inserts*: the `id` of every row
 * nested under an `insert:` key (nested `insert:` blocks included). Id-targeted
 * rows (`- id: x` carrying `config`/`disabled`) patch an existing entry and may
 * repeat across layers; only inserts create new entries, so a repeated insert id
 * is exactly the host's hard `duplicate loader entry id` failure.
 */
export function collectInsertIds(text: string): string[] {
  const lines = text.split('\n')
  const ids: string[] = []
  // Indentation of each `insert:` key currently in scope (a stack so a nested
  // insert block does not hide its siblings).
  const stack: number[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = /^(\s*)/.exec(line)?.[1].length ?? 0
    while (stack.length > 0 && indent <= stack[stack.length - 1]) stack.pop()
    const key = /^(\s*)(?:-\s*)?insert\s*:\s*$/.exec(line)
    if (key !== null) {
      stack.push(key[1].length)
      continue
    }
    if (stack.length > 0) {
      const m = ID_RE.exec(line)
      if (m !== null) ids.push(m[2])
    }
  }
  return ids
}

/** Parse rows including each block's `name:` (for bundle-built plugin rows). */
export function parseNamedRows(text: string): NamedRow[] {
  const lines = text.split('\n')
  const rows: NamedRow[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = ID_RE.exec(lines[i])
    if (m === null) continue
    const end = blockEnd(lines, i)
    let name: string | undefined
    let disabled = false
    for (let j = i + 1; j < end; j++) {
      const n = /\bname:\s*['"]?([^'"]+)['"]?\s*$/.exec(lines[j])
      if (n !== null) name = n[1]
      const d = /\bdisabled:\s*(true|false)/.exec(lines[j])
      if (d !== null) disabled = d[1] === 'true'
    }
    rows.push({ id: m[2], name, disabled })
  }
  return rows
}

/**
 * Return a new `cordis.patch.yml` text with the named row's disabled state set.
 * Preserves all untouched lines. Idempotent: setting the same value is a no-op.
 */
export function setRowDisabled(text: string, id: string, disabled: boolean): string {
  text = stripEmptyArrayMarker(text)
  const lines = text.split('\n')
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

/** Parse every patch row, classifying each block's shape (name/disabled/config/insert). */
export function parseClassifiedRows(text: string): ClassifiedRow[] {
  const lines = text.split('\n')
  const rows: ClassifiedRow[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = ID_RE.exec(lines[i])
    if (m === null) continue
    const end = blockEnd(lines, i)
    let name: string | undefined
    let disabled = false
    let hasConfig = false
    let hasInsert = false
    for (let j = i + 1; j < end; j++) {
      const line = lines[j]
      const n = /\bname:\s*['"]?([^'"]+)['"]?\s*$/.exec(line)
      if (n !== null) name = n[1]
      if (/\bdisabled:\s*true/.test(line)) disabled = true
      if (/^\s*config\s*:/.test(line)) hasConfig = true
      if (/^\s*insert\s*:/.test(line)) hasInsert = true
    }
    rows.push({ id: m[2], name, disabled, hasConfig, hasInsert })
  }
  return rows
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
  const lines = text.split('\n')
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
  const lines = text.split('\n')
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
  const lines = text.split('\n')
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
  const lines = text.split('\n')
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
  const lines = base.split('\n')
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
  const lines = base.split('\n')
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
  const lines = text.split('\n')
  const idx = findIdLine(lines, id)
  if (idx === undefined) return undefined
  return lines.slice(idx, blockEnd(lines, idx)).join('\n')
}

/** Extract the value text of a named key (`config`, `name`, …) within a row's
 * block. Returns the scalar value for `config: {}`/`config: str`, or the
 * sub-block text (with the key's 2-space nesting stripped) for a block form.
 * `undefined` when the row or key is absent. */
export function extractKeyValue(text: string, id: string, key: string): string | undefined {
  const lines = text.split('\n')
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