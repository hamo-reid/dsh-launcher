/** The skill half of `ext:*`: what a dsh discovers on disk, and the launcher-global
 * library where skills are collected, created from a scaffold, and installed.
 *
 * The launcher writes no skill TEXT: a skill is a directory — scripts, references
 * and assets beside its SKILL.md — so editing one is not a text box's job. Every
 * copy offers the same two ways out instead: show its folder, or hand the skill to
 * the editor (a bundle goes in as its folder, which opens as a workspace). Creating
 * one writes the launcher's own scaffold (a valid file to start from), and never
 * overwrites anything. */


import { existsSync } from 'node:fs'
import { dialog, shell } from 'electron'
import { join } from 'node:path'
import { ctxOf } from '../ctxOf.ts'
import { handle } from '../handle.ts'
import { profileRefused, profileTarget } from '../validate.ts'
import { logger } from '../../core/shared/logger.ts'
import { dialogFilter, dialogTitle } from '../../core/shared/dialog-text.ts'
import {
  deleteSkill, folderImportProblem, importSkillFolder, importSkillZip, installFolderSkills,
  installedEntry, installZipSkills, listSkills, parseSkillText, requireWritableSkillRoot,
  scaffoldSkill, skillLocationOf, writeSkill, zipImportProblem,
} from '../../core/skills/skills.ts'
import {
  deleteSkillLib, findSkillLibEntry, installSkillToDsh, listSkillLibrary, scanLibraryInstalls,
  skillLibraryDir, skillLibShape, skillLibTextOf, writeSkillLib,
} from '../../core/skills/library.ts'
import { SKILL_NAME_RE } from '../../../shared/skill.ts'
import { fail, failFromError, E } from '../../core/shared/errors.ts'
import type { ParsedSkill } from '../../core/skills/frontmatter.ts'
import type { IpcResult, SkillEntry, SkillLibEntry, SkillLibOverviewRow, SkillListing } from '../../../shared/types.ts'


/** Show one skill's folder in the OS file manager. A bundle's folder is the skill
 * itself (its resource files live there); a flat `<name>.md` has its root as its
 * folder, which is where the file is. */
async function revealDir(dir: string): Promise<IpcResult<boolean>> {
  const error = await shell.openPath(dir)
  return error === '' ? { ok: true, value: true } : fail(E.shellOpenPath, { detail: error })
}

/** Open one skill in VS Code, through the protocol the editor registers: spawning
 * `code` would depend on a PATH entry, and the protocol is the editor's own
 * contract for "open this thing" (the same call the presets page makes). A protocol
 * URL takes forward slashes on every platform, a Windows drive included.
 *
 * `target` is the skill ITSELF, and for a bundle that is its folder: the editor
 * opens a folder as a workspace, so the scripts and references sit in the tree
 * beside the SKILL.md. A flat `<name>.md` has no folder of its own (its folder is
 * the whole root), so the caller passes the file for that case. */
async function openInEditor(target: string): Promise<IpcResult<boolean>> {
  await shell.openExternal(`vscode://file/${target.replace(/\\/g, '/')}`)
  return { ok: true, value: true }
}

/** Map what an import landed onto the LIBRARY's entry shape: a bundle's `path` is
 * its SKILL.md and its `dir` the folder that holds it (the same convention
 * `listSkillLibrary` uses). Both import sources share this, so the two handlers
 * cannot disagree about what they returned. */
function libEntriesOf(installed: ReadonlyArray<{ skill: ParsedSkill; dir: string }>): SkillLibEntry[] {
  return installed.map(({ skill, dir }) => ({
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
    modelInvocable: skill.modelInvocable,
    userInvocable: skill.userInvocable,
    path: join(dir, 'SKILL.md'),
    dir,
  }))
}

/** The library's own "this name is taken" probe: a bundle directory OR a flat
 * `<name>.md` — both are skills the library lists, so an import must refuse
 * either. Resolved per call, because the library directory derives from the
 * data root and can change between calls. */
function libExists(): (name: string) => boolean {
  const libDir = skillLibraryDir()
  return name => existsSync(join(libDir, name)) || existsSync(join(libDir, `${name}.md`))
}

/** Pick one folder, or answer `null` when the dialog was dismissed. The path a
 * drag & drop (or a caller) passes is used as-is: the dialog is only the way to
 * NAME one. */
async function pickFolder(folderPath?: string): Promise<string | null> {
  if (typeof folderPath === 'string' && folderPath !== '') return folderPath
  const dialoged = await dialog.showOpenDialog({
    title: dialogTitle('skillFolder'),
    properties: ['openDirectory'],
  })
  if (dialoged.canceled || dialoged.filePaths.length === 0) return null
  return dialoged.filePaths[0]
}

export function registerSkillsExtIpc(): void {
  // Every root dsh scans, the discovered catalog (rank order), and every
  // skill-like file dsh would silently ignore — surfaced with the reason.
  //
  // `profile` is optional and validated, never inferred: it becomes a PATH and it
  // decides which presets compose, so a name that is unknown must not silently
  // degrade into "this dsh with no preset roots" — that reads like "this
  // deployment contributes no skills" when the truth is "you named a profile
  // that is not there".
  handle('ext:skillList', (_event, dshId: string, profile?: string): IpcResult<SkillListing> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    const pick = profileTarget(ctx, profile)
    if (profileRefused(pick)) return pick
    try {
      return { ok: true, value: listSkills(ctx, pick !== null ? { profile: pick } : {}) }
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

  // Create a skill in this dsh's writable root from the launcher's own scaffold:
  // a valid SKILL.md to start from. A name the root already holds is refused by
  // core (`ext.skillExists`) — nothing is ever overwritten here.
  handle('ext:skillCreate', (_event, dshId: string, name: string): IpcResult<SkillEntry> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (!SKILL_NAME_RE.test(name)) return fail(E.extBadSkill, { detail: name })
    try {
      return { ok: true, value: writeSkill(ctx, null, scaffoldSkill(name)) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Show where one skill lives. Any copy the page can list may be opened, in a
  // read-only root included — `profile` decides which preset roots compose, so it
  // has to be the one the listing was read with.
  handle('ext:skillReveal', async (_event, dshId: string, name: string, profile?: string): Promise<IpcResult<boolean>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (!SKILL_NAME_RE.test(name)) return fail(E.extBadSkill, { detail: name })
    const pick = profileTarget(ctx, profile)
    if (profileRefused(pick)) return pick
    try {
      const { dir } = skillLocationOf(ctx, name, pick !== null ? { profile: pick } : {})
      return await revealDir(dir)
    } catch (error) {
      return failFromError(error)
    }
  })

  // Open one skill in the editor. A bundle goes in as its FOLDER — that is the
  // whole point of not editing it here: the scripts and references are part of the
  // skill, and a folder opens as a workspace.
  handle('ext:skillOpenEditor', async (_event, dshId: string, name: string, profile?: string): Promise<IpcResult<boolean>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (!SKILL_NAME_RE.test(name)) return fail(E.extBadSkill, { detail: name })
    const pick = profileTarget(ctx, profile)
    if (profileRefused(pick)) return pick
    try {
      const { path, dir, shape } = skillLocationOf(ctx, name, pick !== null ? { profile: pick } : {})
      return await openInEditor(shape === 'flat' ? path : dir)
    } catch (error) {
      return failFromError(error)
    }
  })

  // Install a zip's skills into this dsh's writable root (all-or-nothing). With no
  // `zipPath` a file dialog picks the archive; a drag & drop passes its resolved
  // path. Cancel returns `null` (not an error), like the library entry.
  handle('ext:skillImportZip', async (_event, dshId: string, zipPath?: string): Promise<IpcResult<SkillEntry[] | null>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    let picked: string
    if (typeof zipPath === 'string' && zipPath !== '') {
      picked = zipPath
    } else {
      const dialoged = await dialog.showOpenDialog({
        title: dialogTitle('skillZip'),
        properties: ['openFile'],
        filters: [dialogFilter('skillZip', ['zip'])],
      })
      if (dialoged.canceled || dialoged.filePaths.length === 0) return { ok: true, value: null }
      picked = dialoged.filePaths[0]
    }
    const problem = zipImportProblem(picked)
    if (problem !== null) return fail(problem.code, { detail: problem.detail })
    try {
      const installed = importSkillZip(ctx, picked)
      logger.info(`skills: imported ${installed.length} skill(s) into ${dshId} from ${picked}`)
      return { ok: true, value: installed }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Install a folder's skills into this dsh's writable root (all-or-nothing).
  // The folder is COPIED, never linked: what lands is a snapshot like a zip's, and
  // "make dsh scan that directory" stays `customSkillDirs`, a different feature.
  // Cancel returns `null` (not an error), like the archive entry above.
  handle('ext:skillImportFolder', async (_event, dshId: string, folderPath?: string): Promise<IpcResult<SkillEntry[] | null>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    const picked = await pickFolder(folderPath)
    if (picked === null) return { ok: true, value: null }
    const problem = folderImportProblem(picked)
    if (problem !== null) return fail(problem.code, { detail: problem.detail })
    try {
      const installed = importSkillFolder(ctx, picked)
      logger.info(`skills: imported ${installed.length} skill(s) into ${dshId} from folder ${picked}`)
      return { ok: true, value: installed }
    } catch (error) {
      return failFromError(error)
    }
  })

  // The library catalog plus every file that would not load, with the reason.
  handle('ext:libSkillList', (): IpcResult<{ skills: SkillLibEntry[]; issues: { path: string; reason: string }[] }> => {
    try {
      return { ok: true, value: listSkillLibrary() }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Entries with their per-dsh install states (installed / stale) in one scan:
  // every dsh is read ONCE for the whole page, not once per entry.
  handle('ext:libSkillOverview', (): IpcResult<SkillLibOverviewRow[]> => {
    try {
      const entries = listSkillLibrary().skills
      const cells = scanLibraryInstalls(entries)
      return { ok: true, value: entries.map((entry, i) => ({ entry, installs: cells[i] ?? [] })) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Create a library skill from the launcher's own scaffold, refused when the
  // library already holds that name (core).
  handle('ext:libSkillCreate', (_event, name: string): IpcResult<SkillLibEntry> => {
    if (!SKILL_NAME_RE.test(name)) return fail(E.extBadSkill, { detail: name })
    try {
      return { ok: true, value: writeSkillLib(null, scaffoldSkill(name)) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Show where one library skill lives, in the OS file manager. `undefined` means
  // the entry is gone (it can go between the render and the click).
  handle('ext:libSkillReveal', async (_event, name: string): Promise<IpcResult<boolean>> => {
    if (!SKILL_NAME_RE.test(name)) return fail(E.extBadSkill, { detail: name })
    try {
      const entry = findSkillLibEntry(name)
      if (entry === undefined) return fail(E.extSkillNotFound, { detail: name })
      return await revealDir(entry.dir)
    } catch (error) {
      return failFromError(error)
    }
  })

  // Open one library skill in the editor, on the same rule as a dsh copy: the
  // bundle's folder, or the flat file when the entry has no folder of its own.
  handle('ext:libSkillOpenEditor', async (_event, name: string): Promise<IpcResult<boolean>> => {
    if (!SKILL_NAME_RE.test(name)) return fail(E.extBadSkill, { detail: name })
    try {
      const entry = findSkillLibEntry(name)
      if (entry === undefined) return fail(E.extSkillNotFound, { detail: name })
      return await openInEditor(skillLibShape(entry) === 'flat' ? entry.path : entry.dir)
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

  // Install a skill zip into the LIBRARY (all-or-nothing). With no `zipPath`
  // a file dialog picks the archive; a drag & drop passes its resolved path.
  // Cancel returns `null` (not an error).
  handle('ext:libSkillImportZip', async (_event, zipPath?: string): Promise<IpcResult<SkillLibEntry[] | null>> => {
    let picked: string
    if (typeof zipPath === 'string' && zipPath !== '') {
      picked = zipPath
    } else {
      const dialoged = await dialog.showOpenDialog({
        title: dialogTitle('skillZip'),
        properties: ['openFile'],
        filters: [dialogFilter('skillZip', ['zip'])],
      })
      if (dialoged.canceled || dialoged.filePaths.length === 0) return { ok: true, value: null }
      picked = dialoged.filePaths[0]
    }
    const problem = zipImportProblem(picked)
    if (problem !== null) return fail(problem.code, { detail: problem.detail })
    try {
      const libDir = skillLibraryDir()
      const installed = installZipSkills(libDir, picked, libExists())
      logger.info(`skill library: imported ${installed.length} skill(s) from ${picked}`)
      return { ok: true, value: libEntriesOf(installed) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Install a folder's skills into the LIBRARY (all-or-nothing): same rules as the
  // dsh side, and the entry lands beside the ones the library already holds.
  handle('ext:libSkillImportFolder', async (_event, folderPath?: string): Promise<IpcResult<SkillLibEntry[] | null>> => {
    const picked = await pickFolder(folderPath)
    if (picked === null) return { ok: true, value: null }
    const problem = folderImportProblem(picked)
    if (problem !== null) return fail(problem.code, { detail: problem.detail })
    try {
      const libDir = skillLibraryDir()
      const installed = installFolderSkills(libDir, picked, libExists())
      logger.info(`skill library: imported ${installed.length} skill(s) from folder ${picked}`)
      return { ok: true, value: libEntriesOf(installed) }
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
      const lib = findSkillLibEntry(name)
      if (lib === undefined) return fail(E.extSkillNotFound, { detail: name })
      const root = requireWritableSkillRoot(ctx)
      installSkillToDsh(root, lib, overwrite === true)
      const parsed = parseSkillText(skillLibTextOf(lib))
      if (!parsed.ok) return fail(E.extBadSkill, { detail: name })
      return { ok: true, value: installedEntry(parsed.skill, root, skillLibShape(lib)) }
    } catch (error) {
      return failFromError(error)
    }
  })
}
