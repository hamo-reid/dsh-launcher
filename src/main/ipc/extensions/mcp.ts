/** The MCP half of `ext:*`: the servers a dsh resolves (bundle → profile → home), the launcher-global library, and the secrets that keep their values out of a patch file. */


import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import { ctxOf } from '../ctxOf.ts'
import { handle } from '../handle.ts'
import type { DshContext } from '../../core/profile/appState.ts'
import { homePatchPath, listProfiles, profilePatchPath, readHomePatch } from '../../core/profile/home.ts'
import { listMcpServers } from '../../core/store/combo.ts'
import { diagnoseMcpServers, idTakenElsewhere } from '../../core/mcp/mcp.ts'
import {
  addMcpServer, findMcpServer, mcpRowIds, readMcpServers, removeMcpServer, SERVER_NAME_RE, updateMcpServer,
} from '../../core/mcp/mcp.ts'
import { listMcpSecretNames, setMcpSecret } from '../../core/mcp/secrets.ts'
import { logger } from '../../core/shared/logger.ts'
import {
  findMcpLibraryEntry, listMcpLibrary, mcpInputProblem, removeMcpLibraryEntry, saveMcpLibraryEntry, scanMcpUsages,
} from '../../core/mcp/library.ts'
import { probeMcpServer } from '../../core/mcp/probe.ts'
import { assertPatchDocValid, setRowDisabled } from '../../core/patch/patch.ts'
import { verifyDisabledState } from '../../core/shared/app-util.ts'
import { fail, failFromError, E } from '../../core/shared/errors.ts'
import { rowIdInvalid } from '../validate.ts'
import type {
  IpcResult, McpApplyTarget, McpLayer, McpLibOverviewRow, McpListing, McpProbeResult, McpServer, McpServerInput,
} from '../../../shared/types.ts'



/** A layer the extensions surface may write. `bundle` is read-only (shipped). */

type McpWriteLayer = 'profile' | 'home'

/** The patch file backing a writable layer. */
export function layerPath(ctx: DshContext, profile: string, layer: McpWriteLayer): string {
  return layer === 'home' ? homePatchPath(ctx) : profilePatchPath(ctx, profile)
}

/** Read a patch layer, defaulting to an empty document. */
export function readLayer(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '[]'
}

/** Validate a row id (also the `- id:` token, so the same guard applies). */
export function inputIdInvalid(input: McpServerInput): boolean {
  const id = input.id.trim()
  if (id === '') return false // derived from serverName
  return rowIdInvalid(id)
}

/** Field validation the form and dsh both require. Returns a fail envelope or
 * `null` when the input is acceptable. */
export function rejectInput(input: McpServerInput): IpcResult<never> | null {
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
export function commitLayer(path: string, next: string, verify: (text: string) => boolean, id: string): IpcResult<boolean> {
  assertPatchDocValid(next)
  writeFileSync(path, next)
  const after = readFileSync(path, 'utf8')
  return verify(after) ? { ok: true, value: true } : fail(E.patchWriteVerify, { id })
}

/** Create or update one MCP row in the chosen layer (shared by the per-profile
 * editor and the library's apply/sync paths). */
export function saveMcpRow(ctx: DshContext, profile: string, rawInput: McpServerInput, layer: McpWriteLayer): IpcResult<boolean> {
  try {
    const path = layerPath(ctx, profile, layer)
    const current = readLayer(path)
    // Derived ids keep the serverName's case: lowercasing would collide two
    // names differing only by case onto one row, and the second apply would
    // silently overwrite the first.
    const id = rawInput.id.trim() === '' ? `mcp-${rawInput.serverName.trim()}` : rawInput.id.trim()
    const input = { ...rawInput, id }
    if (!mcpRowIds(current).includes(id) && idResolvesElsewhere(ctx, profile, layer, id)) {
      return fail(E.extMcpIdTaken, { detail: id })
    }
    const next = mcpRowIds(current).includes(id)
      ? updateMcpServer(current, input)
      : addMcpServer(current, input)
    return commitLayer(path, next, text => findMcpServer(text, id)?.serverName === input.serverName, id)
  } catch (error) {
    return failFromError(error)
  }
}

/** Whether an `insert:` of this id would collide with a row that already
 * resolves from another layer, in any profile the write reaches. Overriding such
 * a row is the disable toggle's job — it writes an id-targeted update, never a
 * second insert (see `ext:mcpSetDisabled`). */
export function idResolvesElsewhere(ctx: DshContext, profile: string, layer: McpWriteLayer, id: string): boolean {
  // A home row is resolved by EVERY profile, so a home write has to consider
  // them all; a profile write only ever lands in that one profile's resolution.
  const profiles = layer === 'profile' ? [profile] : listProfiles(ctx)
  for (const candidate of profiles) {
    let resolved: McpServer[]
    try {
      resolved = listMcpServers(ctx, candidate)
    } catch {
      // An unreadable profile (no manifest, a corrupt one) has no rows to
      // collide with — this guard is a safety net, never the reason a save
      // fails; the write itself reports whatever is actually wrong.
      continue
    }
    if (idTakenElsewhere(resolved, layer, id)) return true
  }
  return false
}

export function registerMcpExtIpc(): void {
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

  // The dsh's home-layer MCP rows alone — the "every profile of this dsh"
  // scope, manageable from the DSH page without picking a profile.
  handle('ext:mcpHomeList', (_event, dshId: string): IpcResult<McpServer[]> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    return { ok: true, value: diagnoseMcpServers(readMcpServers(readHomePatch(ctx).text, 'home')) }
  })

  // Create or update one MCP row in the chosen layer.
  handle('ext:mcpSave', (_event, dshId: string, profile: string, input: McpServerInput, layer: McpWriteLayer): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (layer !== 'profile' && layer !== 'home') return fail(E.internal, undefined, 'bad layer')
    const rejected = rejectInput(input)
    if (rejected !== null) return rejected
    return saveMcpRow(ctx, profile, input, layer)
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

  // The stored launch secrets: names only — values never cross to the renderer,
  // and the patch file only ever holds a `!!js process.env.<name>` reference.
  handle('ext:mcpSecrets', (): IpcResult<string[]> => {
    return { ok: true, value: listMcpSecretNames() }
  })

  // Save (or, with `''`, clear) one launch secret.
  handle('ext:mcpSecretSet', (_event, name: string, value: string): IpcResult<boolean> => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return fail(E.extBadEnvName, { detail: name })
    try {
      setMcpSecret(name, value)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Clear one launch secret (idempotent: absent names are a no-op).
  handle('ext:mcpSecretRemove', (_event, name: string): IpcResult<boolean> => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { ok: true, value: false }
    setMcpSecret(name, null)
    return { ok: true, value: true }
  })

  // Every entry, plus where it is applied and how much has drifted: one scan
  // per entry over all registered dsh's (profile + home layers).
  handle('ext:libMcpOverview', (): IpcResult<McpLibOverviewRow[]> => {
    try {
      return {
        ok: true,
        value: listMcpLibrary().map(entry => {
          const usages = scanMcpUsages(entry)
          return {
            entry,
            applied: usages.length,
            stale: usages.filter(u => u.stale && !u.handwritten).length,
            handwritten: usages.filter(u => u.handwritten).length,
          }
        }),
      }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Create or update one library entry (`previousServerName` renames).
  handle('ext:libMcpSave', (_event, previousServerName: string | null, input: McpServerInput): IpcResult<boolean> => {
    const problem = mcpInputProblem(input)
    if (problem !== null) return fail(problem.code, { detail: problem.message })
    try {
      saveMcpLibraryEntry(previousServerName, input)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Delete one library entry. Applied rows are materialized copies and stay.
  handle('ext:libMcpRemove', (_event, serverName: string): IpcResult<boolean> => {
    if (typeof serverName !== 'string' || serverName === '') return fail(E.extBadServerName, { detail: serverName })
    removeMcpLibraryEntry(serverName)
    return { ok: true, value: true }
  })

  // Materialize a library entry as a row in a profile layer or the home layer.
  // A row with the same serverName in the target layer blocks a second insert.
  handle('ext:libMcpApply', (_event, serverName: string, target: McpApplyTarget): IpcResult<boolean> => {
    const entry = findMcpLibraryEntry(serverName)
    if (entry === undefined) return fail(E.extMcpNotInLib, { detail: serverName })
    if (target === null || typeof target !== 'object') return fail(E.internal, undefined, 'bad target')
    if (target.layer !== 'profile' && target.layer !== 'home') return fail(E.internal, undefined, 'bad layer')
    if (target.layer === 'profile' && (typeof target.profile !== 'string' || target.profile === '')) {
      return fail(E.internal, undefined, 'profile target needs a profile')
    }
    const ctx = ctxOf(target.dshId)
    if (ctx === null) return fail(E.dshNotFound)
    // Validate the input as it will be WRITTEN: an entry's own `id` is
    // discarded on apply (`saveMcpRow` derives it from the serverName), so
    // checking it here would refuse an entry this path can happily apply.
    const rejected = rejectInput({ ...entry.input, id: '' })
    if (rejected !== null) return rejected
    try {
      // A second row claiming one serverName is a real dsh load failure, so the
      // check runs over the RESOLVED rows (bundle → profile → home), not the
      // target layer's own text: a same-name row in ANY layer blocks. A home
      // target joins every profile's resolution; with no profiles, the home
      // layer's own rows are all there is.
      const profiles = target.layer === 'profile' ? [target.profile ?? ''] : listProfiles(ctx)
      let clash = profiles.some(profile =>
        listMcpServers(ctx, profile).some(server => server.serverName === entry.serverName))
      if (!clash && profiles.length === 0) {
        clash = readMcpServers(readHomePatch(ctx).text, 'home').some(server => server.serverName === entry.serverName)
      }
      if (clash) return fail(E.extMcpExists, { detail: entry.serverName })
      return saveMcpRow(ctx, target.profile ?? '', { ...entry.input, id: '' }, target.layer)
    } catch (error) {
      return failFromError(error)
    }
  })

  // One-click sync: rewrite every drifted, non-handwritten applied row from the
  // library (row ids and disabled flags preserved). Handwritten rows are
  // reported as skipped, never overwritten.
  handle('ext:libMcpSync', (_event, serverName: string): IpcResult<{ updated: number; skipped: number }> => {
    const entry = findMcpLibraryEntry(serverName)
    if (entry === undefined) return fail(E.extMcpNotInLib, { detail: serverName })
    let updated = 0
    let skipped = 0
    for (const usage of scanMcpUsages(entry)) {
      if (!usage.stale) continue
      if (usage.handwritten) { skipped++; continue }
      const ctx = ctxOf(usage.dshId)
      if (ctx === null) { skipped++; continue }
      const input: McpServerInput = {
        ...entry.input,
        id: usage.id,
        ...(usage.disabled ? { disabled: true } : {}),
      }
      const r = saveMcpRow(ctx, usage.target.kind === 'profile' ? usage.target.profile : '', input, usage.target.kind)
      if (r.ok) updated++
      else skipped++
    }
    if (updated > 0) logger.info(`mcp library: synced ${serverName} → ${updated} row(s)`)
    return { ok: true, value: { updated, skipped } }
  })

  // Connectivity probe for one library entry: a real initialize handshake against
  // the server (stdio spawn or HTTP POST), reported inline as ok/reason/elapsed.
  // The launcher never calls tools, and a dead server is a VALUE (`ok:false`),
  // not an IPC failure — so the card shows the reason instead of a toast.
  handle('ext:libMcpTest', async (_event, serverName: string): Promise<IpcResult<McpProbeResult>> => {
    if (typeof serverName !== 'string' || serverName === '') return fail(E.extBadServerName, { detail: String(serverName) })
    const entry = findMcpLibraryEntry(serverName)
    if (entry === undefined) return fail(E.extMcpNotInLib, { detail: serverName })
    return { ok: true, value: await probeMcpServer(entry.input, { clientVersion: app.getVersion() }) }
  })
}
