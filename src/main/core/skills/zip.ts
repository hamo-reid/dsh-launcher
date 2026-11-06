/**
 * Installing skills from a ZIP: the zip-slip guard, the pre-flight check for a
 * dropped file, and the two-pass all-or-nothing install.
 *
 * The two passes are shared with `folder.ts` — a zip and a folder differ only in
 * where the candidates come from, so the collision rules and the rollback live
 * here once (`parseSkillDirs` + `installCandidates`) instead of drifting apart in
 * two copies.
 *
 * Takes the target root and an `exists` probe rather than a context, so it does not
 * depend on the module that resolves those.
 */



import AdmZip from 'adm-zip'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../shared/logger.ts'
import { parseSkillText } from './frontmatter.ts'
import type { ParsedSkill } from './frontmatter.ts'
import { E, throwE } from '../shared/errors.ts'

/** Zip-slip guard: reject absolute paths, drive prefixes, and `..` segments
 * (backslashes normalized first — Windows-made archives use them). Exported
 * for tests: adm-zip normalizes hostile names on WRITE, so a slip entry can
 * only reach this guard from a third-party archive on READ. */
export function zipEntryUnsafe(entryName: string): boolean {
  const path = entryName.replaceAll('\\', '/')
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return true
  return path.split('/').some(segment => segment === '..')
}

/** Pre-flight for an explicit zip path (drag & drop): extension + is-it-really
 * a file. Zip structure stays `installZipSkills`' job. Returns the error, or
 * `null` when the path may go to `installZipSkills`. */
export function zipImportProblem(zipPath: string): { code: string; detail: string } | null {
  if (!zipPath.toLowerCase().endsWith('.zip')) return { code: E.extSkillZipNotZip, detail: zipPath }
  try {
    if (!statSync(zipPath).isFile()) return { code: E.extSkillZipMissing, detail: zipPath }
  } catch {
    return { code: E.extSkillZipMissing, detail: zipPath }
  }
  return null
}

/** One skill a source carries, before anything is written: its parsed frontmatter
 * and the directory that holds it (its `SKILL.md` and its own resource files). */
export interface SkillCandidate {
  skill: ParsedSkill
  /** Absolute directory to copy, with the skill's own files in it. */
  from: string
}

/**
 * The directory each zip-carried skill lives in, relative to the zip root.
 *
 * A `SKILL.md` at the zip root makes the whole archive one bundle (everything
 * else in it is that skill's resources); otherwise every `SKILL.md` — at any
 * depth, so a GitHub-style `repo-main/` wrapper works — is one skill, carried
 * with its own directory.
 */
function skillZipRoots(names: string[]): string[] {
  if (names.includes('SKILL.md')) return ['']
  const dirs: string[] = []
  for (const name of names) {
    if (!name.endsWith('/SKILL.md')) continue
    const dir = name.slice(0, -'/SKILL.md'.length)
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  // A SKILL.md nested inside another carried skill's directory is that skill's
  // resource, not a separate install — the outer directory moves whole.
  return dirs
    .filter(dir => !dirs.some(other => other !== dir && dir.startsWith(`${other}/`)))
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Parse one batch of candidate directories. Nothing is written: this is the half
 * of the install that can fail on the SOURCE's account (a `SKILL.md` that is not
 * a skill, an unreadable file), so a bad archive or folder leaves the target
 * untouched.
 * @param entries - each candidate's directory and the label its source gives it
 * (`SKILL.md` at a root, `a/SKILL.md` nested), used in the error.
 * @returns the parsed candidates, in the order the source listed them.
 */
export function parseSkillDirs(entries: ReadonlyArray<{ dir: string; label: string }>): SkillCandidate[] {
  return entries.map(({ dir, label }) => {
    const parsed = parseSkillText(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
    if (!parsed.ok) throwE(E.extBadSkill, { detail: label }, `${label}: ${parsed.reason}`)
    return { skill: parsed.skill, from: dir }
  })
}

/**
 * Copy parsed candidates into `targetRoot`, all-or-nothing.
 *
 * A name the target already holds — or a name the batch repeats — refuses the
 * whole batch before anything is copied. The copy then re-checks the same name
 * immediately before writing, because the probe is only the caller's own query:
 * a name that appeared between the two passes would otherwise be silently
 * overwritten, and `errorOnExist` (with `force: false`) is what makes the
 * filesystem itself refuse rather than trust the gap. A failure rolls back
 * whatever landed, so a partial batch never survives.
 * @param targetRoot - the root the skills land in (a dsh's writable root, the library).
 * @param candidates - parsed entries, as `parseSkillDirs` returned them.
 * @param exists - the caller's probe for "this root already holds that name"
 * (it answers for BOTH shapes: a bundle directory and a flat `<name>.md`).
 * @returns what landed, with the directory each skill occupies.
 */
export function installCandidates(
  targetRoot: string,
  candidates: ReadonlyArray<SkillCandidate>,
  exists: (name: string) => boolean,
): Array<{ skill: ParsedSkill; dir: string }> {
  const seen = new Set<string>()
  for (const { skill } of candidates) {
    if (seen.has(skill.name) || exists(skill.name)) throwE(E.extSkillExists, { detail: skill.name })
    seen.add(skill.name)
  }
  mkdirSync(targetRoot, { recursive: true })
  const landed: string[] = []
  try {
    return candidates.map(({ skill, from }) => {
      const dir = join(targetRoot, skill.name)
      // The check that HOLDS: re-asked against the filesystem, right before the
      // bytes move (see the doc comment above).
      if (exists(skill.name)) throwE(E.extSkillExists, { detail: skill.name })
      cpSync(from, dir, { recursive: true, errorOnExist: true, force: false })
      landed.push(dir)
      return { skill, dir }
    })
  } catch (error) {
    for (const dir of landed) rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

/**
 * Install every skill a zip carries into `targetRoot`, all-or-nothing.
 *
 * The archive is extracted to a temp staging dir; every candidate is parsed and
 * collision-checked (against `exists` AND the other candidates) BEFORE anything
 * is installed, so a failure leaves the target untouched. The installed
 * directory name is the frontmatter `name` — the same authority as the editor —
 * and the skill's own directory (scripts, references, …) is carried over whole.
 * Returns what landed, so callers can map to their own entry shapes.
 */
export function installZipSkills(
  targetRoot: string,
  zipPath: string,
  exists: (name: string) => boolean,
): Array<{ skill: ParsedSkill; dir: string }> {
  let arc: AdmZip
  try {
    arc = new AdmZip(zipPath)
  } catch (error) {
    // A dropped file may carry a `.zip` name with garbage bytes — surface that
    // as a readable error instead of adm-zip's raw exception.
    throwE(E.extSkillZipBad, { detail: zipPath }, error instanceof Error ? error.message : String(error))
  }
  const unsafe = arc.getEntries().find(entry => zipEntryUnsafe(entry.entryName))
  if (unsafe !== undefined) throwE(E.extSkillZipUnsafe, { detail: unsafe.entryName })
  const dirs = skillZipRoots(arc.getEntries().map(entry => entry.entryName.replaceAll('\\', '/')))
  if (dirs.length === 0) throwE(E.extSkillZipNoSkill)
  const staging = mkdtempSync(join(tmpdir(), 'pm-skill-import-'))
  try {
    arc.extractAllTo(staging, true)
    // A copy out of staging, not a rename: staging may sit on another drive than
    // the target, where a rename would throw EXDEV.
    return installCandidates(
      targetRoot,
      parseSkillDirs(dirs.map(dir => ({
        dir: join(staging, dir),
        label: dir === '' ? 'SKILL.md' : `${dir}/SKILL.md`,
      }))),
      exists,
    )
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
