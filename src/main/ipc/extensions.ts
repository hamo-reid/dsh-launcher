/**
 * IPC for the extensions surface (`ext:*`).
 *
 * Track A is MCP: the `insert:` rows that mount `@deepseek-ai/dsh-mcp-client`.
 * A row lives either in the profile's own patch layer (this profile only) or in
 * the machine-level home layer (every profile, and it composes AFTER the profile
 * layer). Writes go through the line-level patch editor, so comments and
 * hand-written rows in the target file survive.
 *
 * Editing is allowed while the profile runs: dsh hot-reloads a changed
 * configuration entry in place, which is exactly the "reconnect this server"
 * gesture a user wants.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handle } from './handle.ts'
import { contextForEntry, dshEntryById, type DshContext } from '../core/appState.ts'
import { homePatchPath, profileDir } from '../core/home.ts'
import { listMcpServers } from '../core/combo.ts'
import { addMcpServer, findMcpServer, mcpRowIds, removeMcpServer, SERVER_NAME_RE, updateMcpServer } from '../core/mcp.ts'
import { assertPatchDocValid, setRowDisabled } from '../core/patch.ts'
import { verifyDisabledState } from '../core/app-util.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { rowIdInvalid } from './validate.ts'
import type { IpcResult, McpLayer, McpListing, McpServerInput } from '../../shared/types.ts'

/** A layer the extensions surface may write. `bundle` is read-only (shipped). */
type McpWriteLayer = 'profile' | 'home'

/** Resolve an explicit dsh id to its context, or `null` when unknown. */
function ctxOf(dshId: unknown): DshContext | null {
  if (typeof dshId !== 'string') return null
  const entry = dshEntryById(dshId)
  return entry === undefined ? null : contextForEntry(entry)
}

/** The patch file backing a writable layer. */
function layerPath(ctx: DshContext, profile: string, layer: McpWriteLayer): string {
  return layer === 'home' ? homePatchPath(ctx) : join(profileDir(ctx, profile), 'cordis.patch.yml')
}

/** Read a patch layer, defaulting to an empty document. */
function readLayer(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '[]'
}

/** Validate a row id (also the `- id:` token, so the same guard applies). */
function inputIdInvalid(input: McpServerInput): boolean {
  const id = input.id.trim()
  if (id === '') return false // derived from serverName
  return rowIdInvalid(id)
}

/** Field validation the form and dsh both require. Returns a fail envelope or
 * `null` when the input is acceptable. */
function rejectInput(input: McpServerInput): IpcResult<never> | null {
  if (input === null || typeof input !== 'object') return fail(E.internal, undefined, 'bad input')
  if (inputIdInvalid(input)) return fail(E.nameInvalid, { detail: input.id })
  if (!SERVER_NAME_RE.test(input.serverName ?? '')) return fail(E.extBadServerName, { detail: input.serverName ?? '' })
  if (input.transport !== 'stdio' && input.transport !== 'streamable-http') {
    return fail(E.extBadTransport, { detail: String(input.transport ?? '') })
  }
  if (input.transport === 'stdio' && (input.command ?? '').trim() === '') return fail(E.extNeedCommand)
  if (input.transport === 'streamable-http' && (input.url ?? '').trim() === '') return fail(E.extNeedUrl)
  for (const entry of [...(input.env ?? []), ...(input.headers ?? [])]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)) {
      return fail(E.extBadEnvName, { detail: entry.name })
    }
    if (entry.mode === 'plain' && /[\r\n]/.test(entry.value ?? '')) {
      return fail(E.extBadEnvValue, { detail: entry.name })
    }
  }
  return null
}

/** Write a patch layer after structural validation, then verify the row landed. */
function commitLayer(path: string, next: string, verify: (text: string) => boolean, id: string): IpcResult<boolean> {
  assertPatchDocValid(next)
  writeFileSync(path, next)
  const after = readFileSync(path, 'utf8')
  return verify(after) ? { ok: true, value: true } : fail(E.patchWriteVerify, { id })
}

export function registerExtensionsIpc(): void {
  // Every MCP row the profile resolves (bundle → profile → home), diagnosed.
  handle('ext:mcpList', (_event, dshId: string, profile: string): IpcResult<McpListing> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    const servers = listMcpServers(ctx, profile)
    const layers: McpLayer[] = []
    for (const server of servers) {
      if (!layers.includes(server.layer)) layers.push(server.layer)
    }
    return { ok: true, value: { servers, layers } }
  })

  // Create or update one MCP row in the chosen layer.
  handle('ext:mcpSave', (_event, dshId: string, profile: string, input: McpServerInput, layer: McpWriteLayer): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (layer !== 'profile' && layer !== 'home') return fail(E.internal, undefined, 'bad layer')
    const rejected = rejectInput(input)
    if (rejected !== null) return rejected
    try {
      const path = layerPath(ctx, profile, layer)
      const current = readLayer(path)
      const id = input.id.trim() === '' ? `mcp-${input.serverName.trim().toLowerCase()}` : input.id.trim()
      const next = mcpRowIds(current).includes(id)
        ? updateMcpServer(current, { ...input, id })
        : addMcpServer(current, { ...input, id })
      return commitLayer(path, next, text => findMcpServer(text, id)?.serverName === input.serverName, id)
    } catch (error) {
      return failFromError(error)
    }
  })

  // Remove one MCP row (its `insert:` block goes with it when it was the last).
  handle('ext:mcpRemove', (_event, dshId: string, profile: string, id: string, layer: McpWriteLayer): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (layer !== 'profile' && layer !== 'home') return fail(E.internal, undefined, 'bad layer')
    if (rowIdInvalid(id)) return fail(E.nameInvalid)
    try {
      const path = layerPath(ctx, profile, layer)
      const current = readLayer(path)
      if (!mcpRowIds(current).includes(id)) return fail(E.patchNothingToRemove, { id })
      const next = removeMcpServer(current, id)
      return commitLayer(path, next, text => findMcpServer(text, id) === undefined, id)
    } catch (error) {
      return failFromError(error)
    }
  })

  // Enable / disable one MCP row without deleting it (the reversible off switch).
  // A shipped (bundle) row cannot be edited or removed, but it CAN be switched
  // off: the override is an id-targeted row in the profile layer, which the host
  // merges over the bundle's insert — never a second insert of the same server.
  handle('ext:mcpSetDisabled', (_event, dshId: string, profile: string, id: string, disabled: boolean, layer: McpWriteLayer): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (layer !== 'profile' && layer !== 'home') return fail(E.internal, undefined, 'bad layer')
    if (rowIdInvalid(id)) return fail(E.nameInvalid)
    try {
      if (!listMcpServers(ctx, profile).some(server => server.id === id)) return fail(E.patchNothingToRemove, { id })
      const path = layerPath(ctx, profile, layer)
      const current = readLayer(path)
      const next = setRowDisabled(current, id, disabled)
      // `verifyDisabledState` reads the id row whether it is an insert child or a
      // bare id-targeted override, so it works for both shapes.
      return commitLayer(path, next, text => verifyDisabledState(text, id, disabled), id)
    } catch (error) {
      return failFromError(error)
    }
  })
}
