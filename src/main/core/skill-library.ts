/**
 * The launcher-global skill library — a launcher-owned directory of
 * `<name>/SKILL.md` bundles (plus their resource files), independent of any
 * dsh.
 *
 * Installing copies the bundle into a dsh's writable root (`<dshHome>/skills`),
 * which is what dsh actually discovers; the copy is then a plain dsh skill.
 * The link between an installed copy and its entry is the frontmatter `name`,
 * so drift ("the library has a newer version") is detected by comparing the
 * SKILL.md texts, and reinstalling re-copies the whole directory.
 *
 * Acceptance rules, scaffolding, and zip import are shared with
 * `core/skills.ts` — a skill the launcher accepts here is one dsh loads.
 * Deletion moves the entry to the OS recycle bin through an injected mover.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger.ts'
import { E, throwE } from './errors.ts'
import { listSkills, parseSkillText, type ParsedSkill } from './skills.ts'
import { contextForEntry, readDshState } from './appState.ts'
import type { SkillLibEntry, SkillLibInstall, SkillLibIssue } from '../../shared/types.ts'

/** The injected OS-recycle-bin move; main wires `shell.trashItem`, tests a fake. */
let trash: ((target: string) => Promise<void>) | null = null

/** Inject the recycle-bin mover (main process wires shell.trashItem). */
export function setSkillLibraryTrash(next: ((target: string) => Promise<void>) | null): void {
  trash = next
}

let dir: string | null = null

/** Wire the library directory (main passes `<userData>/skill-library`). */
export function setSkillLibraryDir(next: string | null): void {
  dir = next
}

function root(): string {
  if (dir === null) throw new Error('skill library dir is not wired')
  return dir
}

/** The wired library directory (for callers composing raw file operations). */
export function skillLibraryDir(): string {
  return root()
}

function toEntry(skill: ParsedSkill, path: string, dir: string): SkillLibEntry {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
    modelInvocable: skill.modelInvocable,
    userInvocable: skill.userInvocable,
    path,
    dir,
  }
}

/** Scan the library the way the dsh-root scan does: a directory contributes
 * `<name>/SKILL.md`, a `.md` file contributes itself; unparseable files are
 * surfaced as issues instead of being dropped. */
export function listSkillLibrary(): { skills: SkillLibEntry[]; issues: SkillLibIssue[] } {
  const skills: SkillLibEntry[] = []
  const issues: SkillLibIssue[] = []
  const base = root()
  let entries
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    mkdirSync(base, { recursive: true })
    return { skills, issues }
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      const file = join(base, entry.name, 'SKILL.md')
      if (!existsSync(file)) continue
      const parsed = parseSkillText(readFileSync(file, 'utf8'))
      if (parsed.ok) skills.push(toEntry(parsed.skill, file, join(base, entry.name)))
      else issues.push({ path: file, reason: parsed.reason })
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const file = join(base, entry.name)
      const parsed = parseSkillText(readFileSync(file, 'utf8'))
      if (parsed.ok) skills.push(toEntry(parsed.skill, file, base))
      else issues.push({ path: file, reason: parsed.reason })
    }
  }
  return { skills, issues }
}

function findEntry(name: string): SkillLibEntry | undefined {
  return listSkillLibrary().skills.find(entry => entry.name === name)
}

/** Full text of one library skill, for the editor modal. */
export function readSkillLibFile(name: string): { text: string; path: string } {
  const found = findEntry(name)
  if (found === undefined) throw new Error(`skill "${name}" is not in the library`)
  return { text: readFileSync(found.path, 'utf8'), path: found.path }
}

/**
 * Create or update a library skill from full file text. The frontmatter `name`
 * is authoritative: editing it renames the entry (an existing dir with the old
 * name moves first); the destination must not collide with another entry.
 */
export function writeSkillLib(previousName: string | null, text: string): SkillLibEntry {
  const parsed = parseSkillText(text)
  if (!parsed.ok) throw new Error(parsed.reason)
  const name = parsed.skill.name
  const destDir = join(root(), name)
  const destFile = join(destDir, 'SKILL.md')
  // Only a CHANGED name is a rename; editing in place keeps the bundle as is.
  const renaming = previousName !== null && previousName !== name
  const previous = renaming ? findEntry(previousName) : undefined
  if (renaming && previous === undefined) {
    throw new Error(`skill "${previousName}" is not in the library`)
  }
  if (previous !== undefined && (existsSync(destDir) || existsSync(join(root(), `${name}.md`)))) {
    throwE(E.extSkillExists, { detail: name })
  }
  if (previous !== undefined) {
    if (previous.dir !== root()) renameSync(previous.dir, destDir) // bundle rename
    else { mkdirSync(destDir, { recursive: true }); renameSync(previous.path, destFile) } // flat → bundle
  } else if (previousName === null) {
    // Fresh creation: the destination must not collide with another entry.
    if (existsSync(destDir) || existsSync(join(root(), `${name}.md`))) {
      throwE(E.extSkillExists, { detail: name })
    }
    mkdirSync(destDir, { recursive: true })
  } else {
    // In-place edit (same name): the bundle dir already exists — keep it and
    // all of its resource files.
    mkdirSync(destDir, { recursive: true })
  }
  writeFileSync(destFile, text)
  if (readFileSync(destFile, 'utf8') !== text) throw new Error('write verify failed')
  // An in-place edit of a flat `<name>.md` entry just became a bundle — drop
  // the flat file so the library does not keep two same-named skills.
  if (previousName === name) rmSync(join(root(), `${name}.md`), { force: true })
  logger.info(`skill library: wrote ${destFile}`)
  return toEntry(parsed.skill, destFile, destDir)
}

/** Move one library skill to the OS recycle bin. The entry is resolved here so
 * nothing outside the library directory can be passed. */
export async function deleteSkillLib(name: string): Promise<void> {
  const found = findEntry(name)
  if (found === undefined) throw new Error(`skill "${name}" is not in the library`)
  if (trash === null) throw new Error('skill library trash mover is not wired')
  const target = found.dir !== root() ? found.dir : found.path
  await trash(target)
  logger.info(`skill library: moved to recycle bin ${target}`)
}

/** Whether a library entry is a bundle (`<name>/SKILL.md`) or a flat
 * `<name>.md` — a flat entry's `dir` is the library ROOT itself. */
export function skillLibShape(lib: SkillLibEntry): 'bundle' | 'flat' {
  return lib.dir === root() ? 'flat' : 'bundle'
}

/**
 * Copy a library skill into a dsh's writable root, in the entry's own shape
 * (`<name>/` or `<name>.md` — dsh discovers both). With `overwrite` this is a
 * reinstall: the existing copy moves aside, the fresh one copies in, the old
 * one is dropped (a straight `cp` over would leave removed files behind). A
 * copy of the OTHER shape moves aside too, so switching an entry between flat
 * and bundle never leaves both behind.
 */
export function installSkillToDsh(
  writableRoot: string,
  lib: SkillLibEntry,
  overwrite: boolean,
): string {
  const shape = skillLibShape(lib)
  mkdirSync(writableRoot, { recursive: true })
  const dest = shape === 'flat' ? join(writableRoot, `${lib.name}.md`) : join(writableRoot, lib.name)
  const other = shape === 'flat' ? join(writableRoot, lib.name) : join(writableRoot, `${lib.name}.md`)
  const copy = (): void => {
    if (shape === 'flat') cpSync(lib.path, dest)
    else cpSync(lib.dir, dest, { recursive: true })
  }
  if (existsSync(dest) || existsSync(other)) {
    if (!overwrite) throwE(E.extSkillExists, { detail: lib.name })
    // The old copy moves aside to a SIBLING temp dir — same volume, so the
    // rename stays atomic (a tmpdir aside would throw EXDEV across drives) —
    // then the fresh copy goes in and the old one is dropped. A failed copy
    // restores the old copy instead of losing it.
    const aside = mkdtempSync(join(writableRoot, '.pm-reinstall-'))
    const old = join(aside, 'old')
    const oldOther = join(aside, 'old-other')
    try {
      if (existsSync(dest)) renameSync(dest, old)
      if (existsSync(other)) renameSync(other, oldOther)
      try {
        copy()
      } catch (error) {
        rmSync(dest, { recursive: true, force: true })
        if (existsSync(old)) renameSync(old, dest)
        if (existsSync(oldOther)) renameSync(oldOther, other)
        throw error
      }
    } finally {
      rmSync(aside, { recursive: true, force: true })
    }
  } else {
    copy()
  }
  logger.info(`skill library: installed ${lib.name} → ${dest}`)
  return dest
}

/** Whether an installed copy is up to date with the library (skill text, line
 * endings normalized — zips made on Windows may carry CRLF). Reads `path`, not
 * `dir` + SKILL.md: a FLAT entry (`<name>.md` in the library root) has the root
 * as its `dir`, so joining would read `<root>/SKILL.md` and throw — which would
 * take down every caller that scans the whole library. */
export function skillLibTextOf(lib: SkillLibEntry): string {
  return readFileSync(lib.path, 'utf8').replaceAll('\r\n', '\n')
}

/** Every dsh where the library skill is (or could be) installed, with drift
 * flags. The launcher installs into (and can only update) the writable
 * user-dsh root, so an editable copy there IS the installed copy — preferred
 * over a same-named entry in a higher-precedence root, which a reinstall could
 * never refresh. With no editable copy, any same-named entry counts (even one
 * that did not originally come from the library). */
export function scanSkillInstalls(lib: SkillLibEntry): SkillLibInstall[] {
  const libText = skillLibTextOf(lib)
  return readDshState().dshes.map((dsh) => {
    const ctx = contextForEntry(dsh)
    const named = listSkills(ctx).skills.filter(skill => skill.name === lib.name)
    const found = named.find(skill => skill.editable) ?? named[0]
    if (found === undefined) {
      return { dshId: dsh.id, dshName: dsh.name, installed: false, stale: false }
    }
    const installedText = readFileSync(found.path, 'utf8').replaceAll('\r\n', '\n')
    return {
      dshId: dsh.id,
      dshName: dsh.name,
      installed: true,
      stale: installedText !== libText,
      entry: found,
    }
  })
}
