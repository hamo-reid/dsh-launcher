/**
 * Adding a skill from a FOLDER.
 *
 * A folder is not an archive: the user points at something they already have on
 * disk — a clone, a copy, a skill someone sent — and what lands in the target
 * root is a COPY, exactly like a zip's contents. The source keeps its own life
 * and is never linked: "make dsh scan this directory" is `customSkillDirs`, a
 * different feature with different consequences (rank 300, outranks the writable
 * root, read-only for the launcher).
 *
 * The shape rules mirror the zip's — a `SKILL.md` at the root makes the whole
 * folder one bundle, otherwise each `<name>/SKILL.md` is one skill — with one
 * deliberate difference: a folder is scanned ONE level deep. A zip needs
 * arbitrary depth because GitHub wraps an archive in `repo-main/`; a folder has
 * no wrapper, and walking it would sweep in every `SKILL.md` of every vendored
 * `node_modules/` below it. Picking the right level is something the user can do
 * by opening the folder.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { E, throwE } from '../shared/errors.ts'
import type { ParsedSkill } from './frontmatter.ts'
import { installCandidates, parseSkillDirs } from './zip.ts'

/**
 * The directories a folder carries skills in: the folder itself when its
 * `SKILL.md` sits at the root (the whole folder is then one bundle, its other
 * files being that skill's resources), otherwise its direct subdirectories that
 * hold one — one level, never deeper.
 * @param folderPath - absolute directory the user picked.
 * @returns absolute candidate directories, in name order; `[]` when there is none.
 */
export function skillFolderDirs(folderPath: string): string[] {
  if (existsSync(join(folderPath, 'SKILL.md'))) return [folderPath]
  let entries
  try {
    entries = readdirSync(folderPath, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.isDirectory() && existsSync(join(folderPath, entry.name, 'SKILL.md')))
    .map(entry => join(folderPath, entry.name))
    .sort((a, b) => a.localeCompare(b))
}

/** Pre-flight for an explicit folder path: it has to BE a directory that can be
 * listed. A dialog only returns existing paths, so this is the drag & drop and
 * vanished-between-click-and-copy guard. Returns the error, or `null` to go on. */
export function folderImportProblem(folderPath: string): { code: string; detail: string } | null {
  try {
    if (statSync(folderPath).isDirectory()) return null
  } catch {
    // Missing, unreadable, or a dangling symlink — one answer for all three.
  }
  return { code: E.extSkillFolderMissing, detail: folderPath }
}

/**
 * Whether copying `from` to `<targetRoot>/<name>` would land INSIDE `from`.
 *
 * `cpSync` copies a directory into its own descendant without complaining until
 * the path gets too long, so a folder that IS the target (or one of its
 * ancestors) has to be refused before anything is written. `resolve` is enough:
 * the launcher does not follow skill symlinks anywhere, and a source reached
 * through one is out of scope here too.
 * @returns `true` when the destination is the source or sits below it.
 */
function nestedTarget(targetRoot: string, from: string, name: string): boolean {
  const dest = resolve(targetRoot, name)
  const rel = relative(resolve(from), dest)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Install every skill a folder carries into `targetRoot`, all-or-nothing.
 *
 * Reads and parses the whole batch first (`parseSkillDirs`), refuses a batch that
 * would copy a folder into itself, and only then copies — through the same
 * `installCandidates` the zip path uses, so the collision rules and the rollback
 * are one implementation, not two.
 * @param targetRoot - the root the skills land in.
 * @param folderPath - the picked folder.
 * @param exists - the caller's probe for "this root already holds that name".
 * @returns what landed, with the directory each skill occupies.
 */
export function installFolderSkills(
  targetRoot: string,
  folderPath: string,
  exists: (name: string) => boolean,
): Array<{ skill: ParsedSkill; dir: string }> {
  const dirs = skillFolderDirs(folderPath)
  if (dirs.length === 0) throwE(E.extSkillFolderNoSkill, { detail: folderPath })
  const candidates = parseSkillDirs(dirs.map(dir => ({ dir, label: join(dir, 'SKILL.md') })))
  for (const { skill, from } of candidates) {
    if (nestedTarget(targetRoot, from, skill.name)) {
      throwE(E.extSkillFolderNested, { detail: join(targetRoot, skill.name) })
    }
  }
  return installCandidates(targetRoot, candidates, exists)
}
