/**
 * JSON codec + helpers for the MCP server modal's text mode.
 *
 * The modal keeps `McpServerInput` as the single source of truth; the JSON
 * document is strictly its mirror (no shorthand encodings) — see
 * `mcpInputToJson` / `jsonToMcpInput`. Pure functions only, no i18n: callers
 * localize `McpJsonProblem` themselves (the sibling `issueLabel` pattern in
 * `McpManagePanel.tsx`).
 */
import type { McpKV, McpReconnect, McpServer, McpServerInput, McpTransport, McpValueMode } from '../../../shared/types.ts'

/** Every key `McpServerInput` declares — anything else in a JSON document is rejected. */
const MCP_INPUT_KEYS = [
  'id', 'serverName', 'transport', 'command', 'args', 'env', 'cwd',
  'url', 'headers', 'toolCallTimeoutMs', 'failOnStartupError', 'reconnect', 'disabled',
] as const

/** Every key `McpReconnect` declares. */
const RECONNECT_KEYS = ['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'] as const

const KV_MODES: readonly McpValueMode[] = ['plain', 'env', 'js']

/** A blank input for a new server. */
export function blankMcpInput(): McpServerInput {
  return { id: '', serverName: '', transport: 'stdio', command: '', args: [], env: [], cwd: '' }
}

/** Seed the form from an existing row (its raw config is not editable here). */
export function fromServer(server: McpServer): McpServerInput {
  return {
    id: server.id,
    serverName: server.serverName,
    transport: server.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    command: server.command ?? '',
    args: server.args ?? [],
    env: server.env ?? [],
    cwd: server.cwd ?? '',
    url: server.url ?? '',
    headers: server.headers ?? [],
    ...(server.toolCallTimeoutMs !== undefined ? { toolCallTimeoutMs: server.toolCallTimeoutMs } : {}),
    ...(server.failOnStartupError !== undefined ? { failOnStartupError: server.failOnStartupError } : {}),
    ...(server.reconnect !== undefined ? { reconnect: server.reconnect } : {}),
    // Without this, editing a disabled row and saving silently re-enables it
    // (`updateMcpServer` resets the row from `input.disabled === true`).
    ...(server.disabled ? { disabled: true } : {}),
  }
}

/** `args` array → the form's multi-line text field (one argument per line). */
export function argsToText(args?: string[]): string {
  return (args ?? []).join('\n')
}

/** The form's multi-line text field → `args` array (blank lines dropped). */
export function argsFromText(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
}

function nonBlankEntries(entries?: McpKV[]): McpKV[] | undefined {
  // Blank rows (a '+' click never filled in) are dropped — the backend
  // rejects an empty name outright.
  return entries?.filter(entry => entry.name !== '')
}

/**
 * What `submit()` actually sends: args from the text field, blank
 * env/headers rows dropped. The JSON projection goes through the same
 * normalization, so form ↔ JSON is a fixed point.
 */
export function normalizeInput(input: McpServerInput, argsText: string): McpServerInput {
  return {
    ...input,
    args: argsFromText(argsText),
    env: nonBlankEntries(input.env),
    headers: nonBlankEntries(input.headers),
  }
}

/** The JSON document shown in text mode: the normalized input, pretty-printed. */
export function mcpInputToJson(input: McpServerInput, argsText: string): string {
  return JSON.stringify(normalizeInput(input, argsText), null, 2)
}

export type McpJsonProblem =
  | { kind: 'parse'; message: string }
  | { kind: 'notObject' }
  | { kind: 'unknown'; keys: string[] }
  | { kind: 'field'; field: string; expected: string }

export type McpJsonResult =
  | { input: McpServerInput; argsText: string }
  | { problem: McpJsonProblem }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseKVList(raw: unknown, field: string): { entries?: McpKV[]; problem?: McpJsonProblem } {
  if (!Array.isArray(raw)) return { problem: { kind: 'field', field, expected: 'McpKV[]' } }
  const entries: McpKV[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (!isRecord(item)) return { problem: { kind: 'field', field: `${field}[${i}]`, expected: '{name, mode, value?}' } }
    const unknownKeys = Object.keys(item).filter(key => key !== 'name' && key !== 'mode' && key !== 'value')
    if (unknownKeys.length > 0) {
      return { problem: { kind: 'unknown', keys: unknownKeys.map(key => `${field}[${i}].${key}`) } }
    }
    if (typeof item['name'] !== 'string') {
      return { problem: { kind: 'field', field: `${field}[${i}].name`, expected: 'string' } }
    }
    if (item['mode'] !== 'plain' && item['mode'] !== 'env' && item['mode'] !== 'js') {
      return { problem: { kind: 'field', field: `${field}[${i}].mode`, expected: `'plain' | 'env' | 'js'` } }
    }
    if (item['value'] !== undefined && typeof item['value'] !== 'string') {
      return { problem: { kind: 'field', field: `${field}[${i}].value`, expected: 'string' } }
    }
    const entry: McpKV = { name: item['name'] as string, mode: item['mode'] as McpValueMode }
    if (typeof item['value'] === 'string') entry.value = item['value']
    entries.push(entry)
  }
  return { entries }
}

function parseReconnect(raw: unknown): { reconnect?: McpReconnect; problem?: McpJsonProblem } {
  if (!isRecord(raw)) return { problem: { kind: 'field', field: 'reconnect', expected: 'object' } }
  const unknownKeys = Object.keys(raw).filter(key => !(RECONNECT_KEYS as readonly string[]).includes(key))
  if (unknownKeys.length > 0) {
    return { problem: { kind: 'unknown', keys: unknownKeys.map(key => `reconnect.${key}`) } }
  }
  const reconnect: McpReconnect = {}
  if (raw['enabled'] !== undefined) {
    if (typeof raw['enabled'] !== 'boolean') {
      return { problem: { kind: 'field', field: 'reconnect.enabled', expected: 'boolean' } }
    }
    reconnect.enabled = raw['enabled']
  }
  for (const key of ['initialDelayMs', 'maxDelayMs', 'maxAttempts'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'number') {
        return { problem: { kind: 'field', field: `reconnect.${key}`, expected: 'number' } }
      }
      reconnect[key] = raw[key] as number
    }
  }
  return { reconnect }
}

/**
 * Parse a JSON document back into modal state. Success fills both the form
 * input and the args text field; failure leaves the form untouched (the
 * caller keeps the last good `input` and only shows the problem).
 */
export function jsonToMcpInput(text: string): McpJsonResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { problem: { kind: 'parse', message: error instanceof Error ? error.message : String(error) } }
  }
  if (!isRecord(parsed)) return { problem: { kind: 'notObject' } }
  const unknownKeys = Object.keys(parsed).filter(key => !(MCP_INPUT_KEYS as readonly string[]).includes(key))
  if (unknownKeys.length > 0) return { problem: { kind: 'unknown', keys: unknownKeys } }

  for (const key of ['id', 'serverName', 'command', 'cwd', 'url'] as const) {
    if (parsed[key] !== undefined && typeof parsed[key] !== 'string') {
      return { problem: { kind: 'field', field: key, expected: 'string' } }
    }
  }
  if (parsed['transport'] !== undefined && parsed['transport'] !== 'stdio' && parsed['transport'] !== 'streamable-http') {
    return { problem: { kind: 'field', field: 'transport', expected: `'stdio' | 'streamable-http'` } }
  }
  if (parsed['args'] !== undefined && (!Array.isArray(parsed['args']) || parsed['args'].some(arg => typeof arg !== 'string'))) {
    return { problem: { kind: 'field', field: 'args', expected: 'string[]' } }
  }
  if (parsed['toolCallTimeoutMs'] !== undefined && typeof parsed['toolCallTimeoutMs'] !== 'number') {
    return { problem: { kind: 'field', field: 'toolCallTimeoutMs', expected: 'number' } }
  }
  for (const key of ['failOnStartupError', 'disabled'] as const) {
    if (parsed[key] !== undefined && typeof parsed[key] !== 'boolean') {
      return { problem: { kind: 'field', field: key, expected: 'boolean' } }
    }
  }

  let env: McpKV[] | undefined
  if (parsed['env'] !== undefined) {
    const r = parseKVList(parsed['env'], 'env')
    if (r.problem !== undefined) return { problem: r.problem }
    env = r.entries
  }
  let headers: McpKV[] | undefined
  if (parsed['headers'] !== undefined) {
    const r = parseKVList(parsed['headers'], 'headers')
    if (r.problem !== undefined) return { problem: r.problem }
    headers = r.entries
  }
  let reconnect: McpReconnect | undefined
  if (parsed['reconnect'] !== undefined) {
    const r = parseReconnect(parsed['reconnect'])
    if (r.problem !== undefined) return { problem: r.problem }
    reconnect = r.reconnect
  }

  // Only keys present in the document land on the result — absent optionals
  // stay absent (the form already coalesces them with `?? ''` / `?? []`), so
  // the projection is an exact mirror and form <-> JSON is a fixed point.
  // The three required fields always get a default, otherwise the form would
  // see `undefined` (an uncontrolled input).
  const input: McpServerInput = {
    id: typeof parsed['id'] === 'string' ? parsed['id'] : '',
    serverName: typeof parsed['serverName'] === 'string' ? parsed['serverName'] : '',
    transport: (parsed['transport'] ?? 'stdio') as McpTransport,
    ...(typeof parsed['command'] === 'string' ? { command: parsed['command'] } : {}),
    ...(Array.isArray(parsed['args']) ? { args: (parsed['args'] as string[]).slice() } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(typeof parsed['cwd'] === 'string' ? { cwd: parsed['cwd'] } : {}),
    ...(typeof parsed['url'] === 'string' ? { url: parsed['url'] } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(typeof parsed['toolCallTimeoutMs'] === 'number' ? { toolCallTimeoutMs: parsed['toolCallTimeoutMs'] } : {}),
    ...(typeof parsed['failOnStartupError'] === 'boolean' ? { failOnStartupError: parsed['failOnStartupError'] } : {}),
    ...(reconnect !== undefined ? { reconnect } : {}),
    ...(typeof parsed['disabled'] === 'boolean' ? { disabled: parsed['disabled'] } : {}),
  }
  const argsText = argsToText(Array.isArray(parsed['args']) ? (parsed['args'] as string[]) : undefined)
  return { input, argsText }
}
