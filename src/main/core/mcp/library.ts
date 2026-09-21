/**
 * The launcher-global MCP server library.
 *
 * A library entry is a definition. Applying it materializes a full row into a
 * profile's patch layer or the dsh's home layer, because dsh only reads
 * configuration from patch files — so an applied row is a COPY, and the
 * `serverName` is the only link back to its entry (no launcher metadata lives
 * in the patch file). "Where is this applied / has it drifted" is therefore
 * computed by scanning every registered dsh's profile and home layers for rows
 * of the same name, and syncing rewrites those rows in place.
 *
 * The library itself lives in the launcher settings (`mcpLibrary`): it is a
 * definition store, not a secret store — the `env` entries carry only
 * `!!js process.env.<NAME>` references, and the values stay in the encrypted
 * secrets map (see `core/mcp/secrets.ts`).
 */
import { updateSettings, loadSettings } from '../settings/settings.ts'
import { logger } from '../shared/logger.ts'
import { E, throwE } from '../shared/errors.ts'
import { contextForEntry, readDshState, type DshContext } from '../profile/appState.ts'
import { listProfiles, readHomePatch } from '../profile/home.ts'
import { listMcpServers } from '../store/combo.ts'
import { readMcpServers, SERVER_NAME_RE } from './mcp.ts'
import type {
  DshEntry, McpKV, McpLibEntry, McpLibUsage, McpReconnect, McpServer, McpServerInput,
} from '../../../shared/types.ts'

/** All entries, sorted by serverName. */
export function listMcpLibrary(): McpLibEntry[] {
  const entries = loadSettings().mcpLibrary ?? []
  return [...entries].sort((a, b) => a.serverName.localeCompare(b.serverName))
}

export function findMcpLibraryEntry(serverName: string): McpLibEntry | undefined {
  return listMcpLibrary().find(entry => entry.serverName === serverName)
}

/** A structural problem with an entry, with the IPC error code the UI should
 * show for it (`mcpInputInvalid` is its message-only form). */
interface McpInputProblem { code: string; message: string }

/** Structural validation for a library entry — the same rules a patch row must
 * satisfy for dsh to load it. Returns the problem, or `null` when acceptable. */
export function mcpInputProblem(input: McpServerInput): McpInputProblem | null {
  if (input === null || typeof input !== 'object') return { code: E.internal, message: 'bad input' }
  if (!SERVER_NAME_RE.test(input.serverName ?? '')) {
    return { code: E.extBadServerName, message: `invalid serverName "${input.serverName ?? ''}"` }
  }
  if (input.transport !== 'stdio' && input.transport !== 'streamable-http') {
    return { code: E.extBadTransport, message: `invalid transport "${String(input.transport ?? '')}"` }
  }
  if (input.transport === 'stdio' && (input.command ?? '').trim() === '') {
    return { code: E.extNeedCommand, message: 'a stdio server needs a command' }
  }
  if (input.transport === 'streamable-http' && (input.url ?? '').trim() === '') {
    return { code: E.extNeedUrl, message: 'a streamable-http server needs a url' }
  }
  for (const entry of [...(input.env ?? []), ...(input.headers ?? [])]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)) {
      return { code: E.extBadEnvName, message: `invalid env/header name "${entry.name}"` }
    }
    // A plain value is written into the patch file as a scalar, so a newline
    // can never be applied (the row writer rejects it). Refusing it here keeps
    // the library from holding an entry that can only ever fail to apply.
    if (entry.mode === 'plain' && /[\r\n]/.test(entry.value ?? '')) {
      return { code: E.extBadEnvValue, message: `a plain env/header value cannot contain a newline ("${entry.name}")` }
    }
  }
  return null
}

export function mcpInputInvalid(input: McpServerInput): string | null {
  return mcpInputProblem(input)?.message ?? null
}

/** Create or update an entry keyed by its `serverName`. `previousServerName`
 * renames (the old key is dropped); applied rows keep their copies under the
 * old name — they simply stop matching the library until re-applied. A create
 * or rename must not land on another entry's name — silently discarding that
 * entry would lose its definition. */
export function saveMcpLibraryEntry(previousServerName: string | null, input: McpServerInput): void {
  const invalid = mcpInputInvalid(input)
  if (invalid !== null) throw new Error(invalid)
  const collides = (loadSettings().mcpLibrary ?? []).some(entry =>
    entry.serverName === input.serverName && entry.serverName !== previousServerName)
  if (collides) throwE(E.extMcpExists, { detail: input.serverName })
  updateSettings(draft => {
    const kept = (draft.mcpLibrary ?? []).filter(entry =>
      entry.serverName !== input.serverName && entry.serverName !== previousServerName)
    kept.push({ serverName: input.serverName, input, updatedAt: new Date().toISOString() })
    draft.mcpLibrary = kept
  })
  logger.info(`mcp library: saved ${input.serverName}`)
}

/** Delete one entry. Applied rows are materialized copies and stay untouched. */
export function removeMcpLibraryEntry(serverName: string): void {
  updateSettings(draft => {
    draft.mcpLibrary = (draft.mcpLibrary ?? []).filter(entry => entry.serverName !== serverName)
  })
  logger.info(`mcp library: removed ${serverName}`)
}

// ── applied-usage scanning ───────────────────────────────────────────────────

function kvCanon(list: McpKV[] | undefined): string {
  return JSON.stringify([...(list ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => entry.mode === 'plain'
      ? { name: entry.name, value: entry.value ?? '' }
      : entry.mode === 'env'
        ? { name: entry.name, ref: true }
        : { name: entry.name, js: entry.value ?? '' }))
}

/** Reconnect options in the fixed key order the row side always rebuilds them
 * in (`readReconnect`), with non-boolean/non-number fields dropped the same way
 * a row read drops them. The form builds the object by spreading patches, so
 * its key order follows the order the user filled the fields in — comparing the
 * raw objects would report drift for a mere key-order difference, and syncing
 * would rewrite the row on every click without ever converging. */
function reconnectCanon(reconnect: McpReconnect | undefined): McpReconnect | undefined {
  if (reconnect === null || typeof reconnect !== 'object') return undefined
  const canon: McpReconnect = {}
  if (typeof reconnect.enabled === 'boolean') canon.enabled = reconnect.enabled
  if (typeof reconnect.initialDelayMs === 'number' && Number.isFinite(reconnect.initialDelayMs)) canon.initialDelayMs = reconnect.initialDelayMs
  if (typeof reconnect.maxDelayMs === 'number' && Number.isFinite(reconnect.maxDelayMs)) canon.maxDelayMs = reconnect.maxDelayMs
  if (typeof reconnect.maxAttempts === 'number' && Number.isFinite(reconnect.maxAttempts)) canon.maxAttempts = reconnect.maxAttempts
  return Object.keys(canon).length > 0 ? canon : undefined
}

/** The semantic config of a definition, in one comparable string. Fields the
 * other transport does not use are dropped so a transport switch always reads
 * as drifted (it is). */
function inputCanon(transport: string, input: {
  command?: string; args?: string[]; cwd?: string; url?: string
  env?: McpKV[]; headers?: McpKV[]
  toolCallTimeoutMs?: number; failOnStartupError?: boolean; reconnect?: McpReconnect
}): string {
  return JSON.stringify({
    transport,
    ...(transport === 'stdio'
      ? {
          command: input.command ?? '',
          args: input.args ?? [],
          cwd: input.cwd ?? '',
          env: kvCanon(input.env),
        }
      : {
          url: input.url ?? '',
          headers: kvCanon(input.headers),
        }),
    toolCallTimeoutMs: input.toolCallTimeoutMs,
    failOnStartupError: input.failOnStartupError === true ? true : undefined,
    reconnect: reconnectCanon(input.reconnect),
  })
}

/** Whether an applied row still matches its library definition. A row with an
 * unparsable config can never match (and is never auto-synced). */
export function mcpRowMatches(entry: McpLibEntry, server: McpServer): boolean {
  if (server.rawConfig !== undefined) return false
  return inputCanon(entry.input.transport, entry.input) === inputCanon(server.transport, server)
}

function usageOf(dsh: DshEntry, entry: McpLibEntry, target: McpLibUsage['target'], server: McpServer): McpLibUsage {
  return {
    dshId: dsh.id,
    dshName: dsh.name,
    target,
    id: server.id,
    disabled: server.disabled,
    stale: !mcpRowMatches(entry, server),
    handwritten: server.rawConfig !== undefined,
  }
}

/** Every patch row across every registered dsh whose `serverName` matches the
 * entry — profile layers and home layers — with drift flags. Bundle rows are
 * shipped read-only and never match (their serverName is dsh's own). */
export function scanMcpUsages(entry: McpLibEntry): McpLibUsage[] {
  const out: McpLibUsage[] = []
  for (const dsh of readDshState().dshes) {
    const ctx: DshContext = contextForEntry(dsh)
    for (const profile of listProfiles(ctx)) {
      for (const server of listMcpServers(ctx, profile)) {
        if (server.layer === 'profile' && server.serverName === entry.serverName) {
          out.push(usageOf(dsh, entry, { kind: 'profile', profile }, server))
        }
      }
    }
    for (const server of readMcpServers(readHomePatch(ctx).text, 'home')) {
      if (server.serverName === entry.serverName) {
        out.push(usageOf(dsh, entry, { kind: 'home' }, server))
      }
    }
  }
  return out
}
