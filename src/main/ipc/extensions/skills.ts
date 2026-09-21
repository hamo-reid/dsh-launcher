/** The skill half of `ext:*`: what a dsh discovers on disk, and the launcher-global library where skills are created, edited and installed. */


import { existsSync } from 'node:fs'
import { dialog } from 'electron'
import { join } from 'node:path'
import { ctxOf } from '../ctxOf.ts'
import { handle } from '../handle.ts'
import { logger } from '../../core/shared/logger.ts'
import {
  deleteSkill, installedEntry, installZipSkills, listSkills, parseSkillText, scaffoldSkill, writableSkillRoot,
  zipImportProblem,
} from '../../core/skills/skills.ts'
import {
  deleteSkillLib, installSkillToDsh, listSkillLibrary, readSkillLibFile, scanSkillInstalls, skillLibraryDir,
  skillLibShape, skillLibTextOf, writeSkillLib,
} from '../../core/skills/library.ts'
import { SKILL_NAME_RE } from '../../../shared/skill.ts'
import { fail, failFromError, E } from '../../core/shared/errors.ts'
import type { IpcResult, SkillEntry, SkillLibEntry, SkillLibOverviewRow, SkillListing } from '../../../shared/types.ts'



/** A layer the extensions surface may write. `bundle` is read-only (shipped). */

export function registerSkillsExtIpc(): void {
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

  // Install a skill zip into the LIBRARY (all-or-nothing). With no `zipPath`
  // a file dialog picks the archive; a drag & drop passes its resolved path.
  // Cancel returns `null` (not an error).
  handle('ext:libSkillImportZip', async (_event, zipPath?: string): Promise<IpcResult<SkillLibEntry[] | null>> => {
    let picked: string
    if (typeof zipPath === 'string' && zipPath !== '') {
      picked = zipPath
    } else {
      const dialoged = await dialog.showOpenDialog({
        title: '选择要导入的 skill 压缩包',
        properties: ['openFile'],
        filters: [{ name: 'Skill 压缩包', extensions: ['zip'] }],
      })
      if (dialoged.canceled || dialoged.filePaths.length === 0) return { ok: true, value: null }
      picked = dialoged.filePaths[0]
    }
    const problem = zipImportProblem(picked)
    if (problem !== null) return fail(problem.code, { detail: problem.detail })
    try {
      const libDir = skillLibraryDir()
      const installed = installZipSkills(
        libDir,
        picked,
        name => existsSync(join(libDir, name)) || existsSync(join(libDir, `${name}.md`)),
      )
      logger.info(`skill library: imported ${installed.length} skill(s) from ${picked}`)
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
      return { ok: true, value: installedEntry(parsed.skill, root, skillLibShape(lib)) }
    } catch (error) {
      return failFromError(error)
    }
  })
}
