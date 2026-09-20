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
 *
 * Track B is Skills: the filesystem roots dsh discovers (see `core/skills.ts`).
 * They are dsh-scoped rather than profile-scoped, so those channels take no
 * profile; writes are confined to the writable user-dsh root, and a delete
 * moves the entry to the OS recycle bin.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dialog } from 'electron'
import { join } from 'node:path'
import { handle } from './handle.ts'
import { contextForEntry, dshEntryById, type DshContext } from '../core/appState.ts'
import { homePatchPath, profileDir } from '../core/home.ts'
import { listMcpServers } from '../core/combo.ts'
import { addMcpServer, findMcpServer, mcpRowIds, removeMcpServer, SERVER_NAME_RE, updateMcpServer } from '../core/mcp.ts'
import { listMcpSecretNames, setMcpSecret } from '../core/mcp-secrets.ts'
import {
  deleteSkill, findEditableSkill, importSkillZip, listSkills, readSkillFile, scaffoldSkill, writeSkill,
} from '../core/skills.ts'
import { SKILL_NAME_RE } from '../../shared/skill.ts'
import { assertPatchDocValid, setRowDisabled } from '../core/patch.ts'
import { verifyDisabledState } from '../core/app-util.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { rowIdInvalid } from './validate.ts'
import type { IpcResult, McpLayer, McpListing, McpServerInput, SkillEntry, SkillListing } from '../../shared/types.ts'

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

  // ── Track B: skills (the filesystem roots dsh discovers) ────────────────────
  // Skills are dsh-scoped, not profile-scoped: every root hangs off the dsh's
  // home (or machine/global config), so these channels take no profile.

  // Every root dsh scans, the discovered catalog (rank order), and every
  // skill-like file dsh would silently ignore — surfaced with the reason.
  handle('ext:skillList', (_event, dshId: string): IpcResult<SkillListing> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    try {
      return { ok: true, value: listSkills(ctx) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Scaffold text for a new skill, rendered by the same renderer that writes it.
  handle('ext:skillScaffold', (_event, name: string): IpcResult<string> => {
    if (!SKILL_NAME_RE.test(name)) return fail(E.extBadSkill, { detail: name })
    return { ok: true, value: scaffoldSkill(name) }
  })

  // Full text of an editable skill, for the editor modal.
  handle('ext:skillRead', (_event, dshId: string, name: string): IpcResult<{ text: string; path: string }> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (!SKILL_NAME_RE.test(name)) return fail(E.extBadSkill, { detail: name })
    try {
      const found = findEditableSkill(ctx, name)
      if (found === undefined) return fail(E.extSkillReadOnly, { detail: name })
      return { ok: true, value: { text: readSkillFile(ctx, name), path: found.entry.path } }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Create (`previousName === null`) or update one skill from full file text.
  // The frontmatter `name` is authoritative; editing it renames the bundle dir.
  handle('ext:skillSave', (_event, dshId: string, previousName: string | null, text: string): IpcResult<SkillEntry> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (previousName !== null && !SKILL_NAME_RE.test(previousName)) return fail(E.extBadSkill, { detail: previousName })
    try {
      return { ok: true, value: writeSkill(ctx, previousName, text) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Move an editable skill to the OS recycle bin (reversible through the OS —
  // the entry is resolved here so nothing outside the writable root can pass).
  handle('ext:skillDelete', async (_event, dshId: string, name: string): Promise<IpcResult<boolean>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (!SKILL_NAME_RE.test(name)) return fail(E.extBadSkill, { detail: name })
    try {
      await deleteSkill(ctx, name)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Pick + install a skill zip. Cancel returns `null` (not an error). Install
  // is all-or-nothing: validation happens on the staged copy before anything
  // lands in the writable root.
  handle('ext:skillImportZip', async (_event, dshId: string): Promise<IpcResult<SkillEntry[] | null>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    const picked = await dialog.showOpenDialog({
      title: '选择要导入的 skill 压缩包',
      properties: ['openFile'],
      filters: [{ name: 'Skill 压缩包', extensions: ['zip'] }],
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: true, value: null }
    try {
      return { ok: true, value: importSkillZip(ctx, picked.filePaths[0]) }
    } catch (error) {
      return failFromError(error)
    }
  })
}
