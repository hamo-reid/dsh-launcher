/**
 * Installing skills from a zip: the zip-slip guard, the pre-flight check for a
 * dropped file, and the two-pass all-or-nothing install.
 *
 * Takes the target root and an `exists` probe rather than a context, so it does not
 * depend on the module that resolves those.
 */



import AdmZip from 'adm-zip'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from './logger.ts'
import { parseSkillText } from './skill-frontmatter.ts'
import type { ParsedSkill } from './skill-frontmatter.ts'
import { E, throwE } from './errors.ts'

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
    // Pass 1 — validate everything: frontmatter, per-zip duplicates, collisions.
    const installs: Array<{ skill: ParsedSkill; from: string }> = []
    const seen = new Set<string>()
    for (const dir of dirs) {
      const label = dir === '' ? 'SKILL.md' : `${dir}/SKILL.md`
      const parsed = parseSkillText(readFileSync(join(staging, dir, 'SKILL.md'), 'utf8'))
      if (!parsed.ok) throwE(E.extBadSkill, { detail: label }, `${label}: ${parsed.reason}`)
      const name = parsed.skill.name
      if (seen.has(name) || exists(name)) {
        throwE(E.extSkillExists, { detail: name })
      }
      seen.add(name)
      installs.push({ skill: parsed.skill, from: join(staging, dir) })
    }
    // Pass 2 — install (copy out of staging → target root; a copy, not a
    // rename, because staging may sit on another drive than the target, where
    // a rename would throw EXDEV).
    mkdirSync(targetRoot, { recursive: true })
    const landed: string[] = []
    try {
      return installs.map(({ skill, from }) => {
        const dir = join(targetRoot, skill.name)
        cpSync(from, dir, { recursive: true })
        landed.push(dir)
        return { skill, dir }
      })
    } catch (error) {
      // Roll back whatever landed so the import stays all-or-nothing.
      for (const dir of landed) rmSync(dir, { recursive: true, force: true })
      throw error
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
