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
import { homePatchPath, listProfiles, profileDir, readHomePatch } from '../core/home.ts'
import { listMcpServers } from '../core/combo.ts'
import { diagnoseMcpServers } from '../core/mcp.ts'
import { addMcpServer, findMcpServer, mcpRowIds, readMcpServers, removeMcpServer, SERVER_NAME_RE, updateMcpServer } from '../core/mcp.ts'
import { listMcpSecretNames, setMcpSecret } from '../core/mcp-secrets.ts'
import { logger } from '../core/logger.ts'
import {
  deleteSkill, installedEntry, installZipSkills, listSkills, parseSkillText, scaffoldSkill, writableSkillRoot,
} from '../core/skills.ts'
import {
  deleteSkillLib, installSkillToDsh, listSkillLibrary, readSkillLibFile, scanSkillInstalls, skillLibraryDir,
  skillLibTextOf, writeSkillLib,
} from '../core/skill-library.ts'
import {
  findMcpLibraryEntry, listMcpLibrary, mcpInputProblem, removeMcpLibraryEntry, saveMcpLibraryEntry, scanMcpUsages,
} from '../core/mcp-library.ts'
import { SKILL_NAME_RE } from '../../shared/skill.ts'
import { assertPatchDocValid, setRowDisabled } from '../core/patch.ts'
import { verifyDisabledState } from '../core/app-util.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { rowIdInvalid } from './validate.ts'
import type {
  IpcResult, McpApplyTarget, McpLayer, McpLibOverviewRow, McpListing, McpServer, McpServerInput, SkillEntry,
  SkillLibEntry, SkillLibOverviewRow, SkillListing,
} from '../../shared/types.ts'

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

/** Create or update one MCP row in the chosen layer (shared by the per-profile
 * editor and the library's apply/sync paths). */
function saveMcpRow(ctx: DshContext, profile: string, rawInput: McpServerInput, layer: McpWriteLayer): IpcResult<boolean> {
  try {
    const path = layerPath(ctx, profile, layer)
    const current = readLayer(path)
    // Derived ids keep the serverName's case: lowercasing would collide two
    // names differing only by case onto one row, and the second apply would
    // silently overwrite the first.
    const id = rawInput.id.trim() === '' ? `mcp-${rawInput.serverName.trim()}` : rawInput.id.trim()
    const input = { ...rawInput, id }
    const next = mcpRowIds(current).includes(id)
      ? updateMcpServer(current, input)
      : addMcpServer(current, input)
    return commitLayer(path, next, text => findMcpServer(text, id)?.serverName === input.serverName, id)
  } catch (error) {
    return failFromError(error)
  }
}

/** Register every `ext:*` channel. */
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

  // ── Track B: skills (the filesystem roots dsh discovers) ────────────────────
  // Skills are dsh-scoped, not profile-scoped: every root hangs off the dsh's
  // home (or machine/global config), so these channels take no profile. The
  // launcher-global LIBRARY (below) is where skills are created and edited;
  // here a dsh only lists what it discovers and drops what it holds.

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

  // ── MCP library (launcher-global definitions) ───────────────────────────────

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
    const rejected = rejectInput(entry.input)
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

  // ── Skill library (launcher-global bundles) ─────────────────────────────────

  // The library catalog plus every file that would not load, with the reason.
  handle('ext:libSkillList', (): IpcResult<{ skills: SkillLibEntry[]; issues: { path: string; reason: string }[] }> => {
    try {
      return { ok: true, value: listSkillLibrary() }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Entries with their per-dsh install states (installed / stale) in one scan.
  handle('ext:libSkillOverview', (): IpcResult<SkillLibOverviewRow[]> => {
    try {
      return {
        ok: true,
        value: listSkillLibrary().skills.map(entry => ({ entry, installs: scanSkillInstalls(entry) })),
      }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Scaffold text for a new library skill, rendered by the same renderer that
  // writes it.
  handle('ext:libSkillScaffold', (_event, name: string): IpcResult<string> => {
    if (!SKILL_NAME_RE.test(name)) return fail(E.extBadSkill, { detail: name })
    return { ok: true, value: scaffoldSkill(name) }
  })

  // Full text of one library skill, for the editor modal.
  handle('ext:libSkillRead', (_event, name: string): IpcResult<{ text: string; path: string }> => {
    if (!SKILL_NAME_RE.test(name)) return fail(E.extBadSkill, { detail: name })
    try {
      return { ok: true, value: readSkillLibFile(name) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Create (`previousName === null`) or update one library skill from full file
  // text; the frontmatter `name` is authoritative and renames the entry.
  handle('ext:libSkillSave', (_event, previousName: string | null, text: string): IpcResult<SkillLibEntry> => {
    if (previousName !== null && !SKILL_NAME_RE.test(previousName)) return fail(E.extBadSkill, { detail: previousName })
    try {
      return { ok: true, value: writeSkillLib(previousName, text) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Move one library skill to the OS recycle bin (entry resolved in core, so
  // nothing outside the library directory can be passed).
  handle('ext:libSkillDelete', async (_event, name: string): Promise<IpcResult<boolean>> => {
    if (!SKILL_NAME_RE.test(name)) return fail(E.extBadSkill, { detail: name })
    try {
      await deleteSkillLib(name)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Pick a skill zip and install its skills into the LIBRARY (all-or-nothing).
  // Cancel returns `null` (not an error).
  handle('ext:libSkillImportZip', async (): Promise<IpcResult<SkillLibEntry[] | null>> => {
    const picked = await dialog.showOpenDialog({
      title: '选择要导入的 skill 压缩包',
      properties: ['openFile'],
      filters: [{ name: 'Skill 压缩包', extensions: ['zip'] }],
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: true, value: null }
    try {
      const libDir = skillLibraryDir()
      const installed = installZipSkills(
        libDir,
        picked.filePaths[0],
        name => existsSync(join(libDir, name)) || existsSync(join(libDir, `${name}.md`)),
      )
      logger.info(`skill library: imported ${installed.length} skill(s) from ${picked.filePaths[0]}`)
      return {
        ok: true,
        value: installed.map(({ skill, dir }) => ({
          name: skill.name,
          description: skill.description,
          ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
          modelInvocable: skill.modelInvocable,
          userInvocable: skill.userInvocable,
          path: join(dir, 'SKILL.md'),
          dir,
        })),
      }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Copy a library skill into a dsh's writable root (`overwrite` = reinstall).
  handle('ext:libSkillInstall', (_event, name: string, dshId: string, overwrite: boolean): IpcResult<SkillEntry> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (!SKILL_NAME_RE.test(name)) return fail(E.extBadSkill, { detail: name })
    try {
      const lib = listSkillLibrary().skills.find(candidate => candidate.name === name)
      if (lib === undefined) return fail(E.extSkillNotFound, { detail: name })
      const root = writableSkillRoot(ctx)
      installSkillToDsh(root, lib, overwrite === true)
      const parsed = parseSkillText(skillLibTextOf(lib))
      if (!parsed.ok) return fail(E.extBadSkill, { detail: name })
      return { ok: true, value: installedEntry(parsed.skill, root) }
    } catch (error) {
      return failFromError(error)
    }
  })
}
