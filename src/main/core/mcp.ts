/**
 * MCP server rows inside a `cordis.patch.yml` layer.
 *
 * dsh mounts `@deepseek-ai/dsh-mcp-client` once per `insert:` row; each row's
 * `config` names the transport and the connection, and its tools appear as
 * `mcp__<serverName>__<tool>`. The launcher reads and writes those rows through
 * the line-level patch editor — never a whole-file YAML dump — so comments and
 * hand-written rows survive an edit.
 *
 * `config.env` is where credentials live. dsh deliberately scrubs ambient
 * credential-shaped variables before spawning a stdio child, so a value must be
 * passed explicitly; the launcher's default is the reference form
 * `!!js process.env.<NAME>`, which keeps the secret out of the patch file (and
 * therefore out of a profile export or a backup).
 */
import { isJsExpr, jsExprText, loadYaml } from './yaml.ts'
import {
  appendInsertChild, extractKeyValue, parseNamedRows, removeInsertRow, setRowConfig, setRowDisabled,
} from './patch.ts'
import type {
  McpIssue, McpKV, McpLayer, McpReconnect, McpServer, McpServerInput, McpTransport,
} from '../../shared/types.ts'

/** The package every MCP row mounts. */
export const MCP_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** dsh's own `serverName` rule (`[A-Za-z0-9_-]{1,32}`). */
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

/** The env-var reference form the launcher writes by default. */
const ENV_REF_RE = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/

/** Derive a stable row id for a server the caller did not pin one for. */
export function defaultRowId(serverName: string): string {
  const slug = serverName.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return `mcp-${slug === '' ? 'server' : slug}`
}

/** A scalar rendered the way dsh's own patches write one: bare when it is
 * unambiguously a string, single-quoted otherwise. */
function yamlScalar(value: string): string {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) && !/^(true|false|null|yes|no|on|off)$/i.test(value)) {
    return value
  }
  return `'${value.replace(/'/g, "''")}'`
}

/** Render one `!!js` value: the bare `process.env.X` form unquoted (matching the
 * shipped examples), any other expression single-quoted so a leading indicator
 * (a backtick, `@`) cannot break the scalar. */
function renderJsValue(expr: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(expr)) return expr
  return `'${expr.replace(/'/g, "''")}'`
}

/** Render one `env` / `headers` entry line (no indent). */
function renderKV(entry: McpKV): string {
  if (entry.mode === 'env') return `${entry.name}: !!js process.env.${entry.name}`
  if (entry.mode === 'js') return `${entry.name}: !!js ${renderJsValue(entry.value ?? '')}`
  return `${entry.name}: ${yamlScalar(entry.value ?? '')}`
}

/** The `config` body for one server, at zero indent. */
export function renderMcpConfigBody(input: McpServerInput): string[] {
  const lines: string[] = [
    `serverName: ${yamlScalar(input.serverName)}`,
    `transport: ${input.transport}`,
  ]
  if (input.transport === 'stdio') {
    if ((input.command ?? '') !== '') lines.push(`command: ${yamlScalar(input.command as string)}`)
    if ((input.args ?? []).length > 0) {
      lines.push(`args: [${(input.args as string[]).map(yamlScalar).join(', ')}]`)
    }
    if ((input.cwd ?? '') !== '') lines.push(`cwd: ${yamlScalar(input.cwd as string)}`)
    if ((input.env ?? []).length > 0) {
      lines.push('env:')
      lines.push(...(input.env as McpKV[]).map(entry => `  ${renderKV(entry)}`))
    }
  } else {
    lines.push(`url: ${yamlScalar(input.url ?? '')}`)
    if ((input.headers ?? []).length > 0) {
      lines.push('headers:')
      lines.push(...(input.headers as McpKV[]).map(entry => `  ${renderKV(entry)}`))
    }
  }
  if (input.toolCallTimeoutMs !== undefined) lines.push(`toolCallTimeoutMs: ${input.toolCallTimeoutMs}`)
  if (input.failOnStartupError === true) lines.push('failOnStartupError: true')
  const rc = input.reconnect
  if (rc !== undefined && Object.values(rc).some(value => value !== undefined)) {
    lines.push('reconnect:')
    if (rc.enabled !== undefined) lines.push(`  enabled: ${rc.enabled}`)
    if (rc.initialDelayMs !== undefined) lines.push(`  initialDelayMs: ${rc.initialDelayMs}`)
    if (rc.maxDelayMs !== undefined) lines.push(`  maxDelayMs: ${rc.maxDelayMs}`)
    if (rc.maxAttempts !== undefined) lines.push(`  maxAttempts: ${rc.maxAttempts}`)
  }
  return lines
}

/** Render one whole MCP row as `insert:` child lines (4-space base indent), ready
 * for {@link appendInsertChild}. */
export function renderMcpRow(input: McpServerInput): string[] {
  const lines: string[] = [
    `    - id: ${input.id}`,
    `      name: ${yamlScalar(MCP_PACKAGE)}`,
  ]
  if (input.disabled === true) lines.push('      disabled: true')
  lines.push('      config:')
  lines.push(...renderMcpConfigBody(input).map(line => `        ${line}`))
  return lines
}

function readKV(value: unknown): McpKV[] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.entries(value as Record<string, unknown>).map(([name, raw]) => {
    if (isJsExpr(raw)) {
      const expr = jsExprText(raw)
      const ref = ENV_REF_RE.exec(expr.trim())
      // Only the canonical `!!js process.env.<same name>` is a reference; any
      // other expression is preserved verbatim as a raw `js` value.
      return ref !== null && ref[1] === name
        ? { name, mode: 'env' as const }
        : { name, mode: 'js' as const, value: expr }
    }
    return { name, mode: 'plain' as const, value: raw === null ? '' : String(raw) }
  })
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function readReconnect(value: unknown): McpReconnect | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const reconnect: McpReconnect = {
    ...(readBool(raw.enabled) !== undefined ? { enabled: readBool(raw.enabled) } : {}),
    ...(readNumber(raw.initialDelayMs) !== undefined ? { initialDelayMs: readNumber(raw.initialDelayMs) } : {}),
    ...(readNumber(raw.maxDelayMs) !== undefined ? { maxDelayMs: readNumber(raw.maxDelayMs) } : {}),
    ...(readNumber(raw.maxAttempts) !== undefined ? { maxAttempts: readNumber(raw.maxAttempts) } : {}),
  }
  return Object.keys(reconnect).length > 0 ? reconnect : undefined
}

/** Parse one row's `config` body. An unreadable body is reported (never hidden):
 * `rawConfig` keeps it for a read-only view. */
function readConfig(raw: string | undefined): { config?: Record<string, unknown>; raw?: string; issues: McpIssue[] } {
  if (raw === undefined || raw.trim() === '') {
    return { raw: raw ?? '', issues: [{ kind: 'unparsable-config', message: 'row has no config' }] }
  }
  let parsed: unknown
  try {
    parsed = loadYaml(raw)
  } catch (error) {
    return { raw, issues: [{ kind: 'unparsable-config', message: error instanceof Error ? error.message : String(error) }] }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { raw, issues: [{ kind: 'unparsable-config', message: 'config is not a mapping' }] }
  }
  return { config: parsed as Record<string, unknown>, issues: [] }
}

/** Read every MCP row declared in one layer's patch text. */
export function readMcpServers(text: string, layer: McpLayer, bundle?: string): McpServer[] {
  return parseNamedRows(text)
    .filter(row => row.name === MCP_PACKAGE)
    .map((row): McpServer => {
      const { config, raw, issues } = readConfig(extractKeyValue(text, row.id, 'config'))
      const server: McpServer = {
        id: row.id,
        serverName: '',
        transport: '',
        layer,
        ...(bundle !== undefined ? { bundle } : {}),
        disabled: row.disabled,
        issues,
      }
      if (config === undefined) {
        server.rawConfig = raw ?? ''
        return server
      }
      server.serverName = readString(config.serverName) ?? ''
      server.transport = readString(config.transport) ?? ''
      const command = readString(config.command)
      if (command !== undefined) server.command = command
      if (Array.isArray(config.args)) server.args = config.args.map(String)
      const cwd = readString(config.cwd)
      if (cwd !== undefined) server.cwd = cwd
      const url = readString(config.url)
      if (url !== undefined) server.url = url
      const env = readKV(config.env)
      if (env !== undefined) server.env = env
      const headers = readKV(config.headers)
      if (headers !== undefined) server.headers = headers
      const timeout = readNumber(config.toolCallTimeoutMs)
      if (timeout !== undefined) server.toolCallTimeoutMs = timeout
      const failOnStartupError = readBool(config.failOnStartupError)
      if (failOnStartupError !== undefined) server.failOnStartupError = failOnStartupError
      const reconnect = readReconnect(config.reconnect)
      if (reconnect !== undefined) server.reconnect = reconnect
      return server
    })
}

/**
 * Fold field-level and cross-row problems back onto each row.
 *
 * The duplicate check mirrors a real dsh failure: two enabled rows claiming one
 * `serverName` in the same registration scope — the later one fails to load. The
 * launcher can name both rows before a session ever starts.
 */
export function diagnoseMcpServers(servers: McpServer[]): McpServer[] {
  const byName = new Map<string, McpServer[]>()
  for (const server of servers) {
    if (server.disabled || server.serverName === '') continue
    const list = byName.get(server.serverName) ?? []
    list.push(server)
    byName.set(server.serverName, list)
  }
  return servers.map((server): McpServer => {
    const issues = [...server.issues]
    if (server.rawConfig === undefined) {
      if (!SERVER_NAME_RE.test(server.serverName)) {
        issues.push({
          kind: 'bad-server-name',
          message: 'serverName must match [A-Za-z0-9_-]{1,32}',
          detail: server.serverName,
        })
      }
      if (server.transport === '') {
        issues.push({ kind: 'missing-transport', message: 'transport is required' })
      } else if (server.transport !== 'stdio' && server.transport !== 'streamable-http') {
        issues.push({
          kind: 'unknown-transport',
          message: 'transport must be stdio or streamable-http',
          detail: server.transport,
        })
      } else if (server.transport === 'stdio' && (server.command ?? '') === '') {
        issues.push({ kind: 'missing-command', message: 'a stdio server needs a command' })
      } else if (server.transport === 'streamable-http' && (server.url ?? '') === '') {
        issues.push({ kind: 'missing-url', message: 'a streamable-http server needs a url' })
      }
    }
    if (!server.disabled) {
      for (const other of byName.get(server.serverName) ?? []) {
        if (other === server) continue
        issues.push({
          kind: 'duplicate-server-name',
          message: `serverName is also used by row "${other.id}"`,
          detail: server.serverName,
          other: {
            layer: other.layer,
            ...(other.bundle !== undefined ? { bundle: other.bundle } : {}),
            id: other.id,
          },
        })
      }
    }
    return { ...server, issues }
  })
}

/**
 * Whether a row carrying this id already comes from a layer OTHER than `layer`.
 * dsh merges rows by id, so an `insert:` of an id that is already resolved from
 * another layer leaves two rows of the same id in play — one of them silently
 * loses (and the launcher diagnoses the pair as a duplicate). Rows in the target
 * layer itself are not a collision: those are updated in place. Disabled rows
 * count too — the merge happens before the off switch is honoured.
 */
export function idTakenElsewhere(resolved: McpServer[], layer: McpLayer, id: string): boolean {
  return resolved.some(server => server.id === id && server.layer !== layer)
}

/** Add a new MCP row to a patch layer. */
export function addMcpServer(text: string, input: McpServerInput): string {
  const id = input.id.trim() === '' ? defaultRowId(input.serverName) : input.id.trim()
  return appendInsertChild(text, renderMcpRow({ ...input, id }))
}

/** Replace an existing MCP row's `config` + `disabled` in place, preserving every
 * other line of the layer. */
export function updateMcpServer(text: string, input: McpServerInput): string {
  const configured = setRowConfig(text, input.id, renderMcpConfigBody(input).join('\n'))
  return setRowDisabled(configured, input.id, input.disabled === true)
}

/** Remove one MCP row; its owning `insert:` block goes with it when it was the
 * last child. */
export function removeMcpServer(text: string, id: string): string {
  return removeInsertRow(text, id)
}

/** Every row id that declares the MCP package (for insert-conflict reporting). */
export function mcpRowIds(text: string): string[] {
  return parseNamedRows(text)
    .filter(row => row.name === MCP_PACKAGE)
    .map(row => row.id)
}

/** One row by id, for a post-write verify. */
export function findMcpServer(text: string, id: string): McpServer | undefined {
  return readMcpServers(text, 'profile').find(server => server.id === id)
}

/** The transports a row may declare, in the order the form offers them. */
export const MCP_TRANSPORTS: readonly McpTransport[] = ['stdio', 'streamable-http']
