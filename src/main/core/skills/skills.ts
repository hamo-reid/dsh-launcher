/**
 * Skills dsh discovers from the filesystem — the launcher's view of the
 * `skill-filesystem` provider in deepseek-harness: resolve the same roots, list
 * the same catalog, and manage the one writable root, `<dshHome>/skills`.
 *
 * Roots mirror the provider (project roots are cwd-dependent and therefore not
 * launcher-managed): `custom` (config rows, rank 300) < `user-dsh`
 * (`<dshHome>/skills`, rank 400) < `user-agents` (`<agentsHome>/skills`, rank
 * 500) < `bundled` (rank 600). A file is a skill only when it opens with a
 * `---` frontmatter naming a lowercase kebab-case skill with a non-empty
 * description; anything else dsh silently ignores, and the launcher surfaces
 * as an issue instead.
 *
 * Deletion is a soft delete: the entry (bundle dir or flat file) moves to the
 * OS recycle bin through an injected `shell.trashItem` (Electron API), so a
 * mistake is reversible without a launcher-side restore UI.
 */


import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readHomePatch } from '../profile/home.ts'
import { extractKeyValue, parseNamedRows } from '../patch/patch.ts'
import { loadYaml, isJsExpr, jsExprText } from '../patch/yaml.ts'
import { logger } from '../shared/logger.ts'
import { E, throwE } from '../shared/errors.ts'
import { presetSkillRoots } from './preset-roots.ts'
import { installZipSkills } from './zip.ts'
import { parseSkillText } from './frontmatter.ts'
import type { ParsedSkill } from './frontmatter.ts'
import type { DshContext } from '../profile/appState.ts'
import type { SkillEntry, SkillIssue, SkillListing, SkillRootInfo, SkillSource } from '../../../shared/types.ts'

// The parse/render layer and the zip import live in their own modules; kept on this
// module's public surface so importers of `./skills.ts` are unchanged.
export { parseSkillText, renderSkillFile, scaffoldSkill } from './frontmatter.ts'
export type { ParsedSkill } from './frontmatter.ts'
export { installZipSkills, zipEntryUnsafe, zipImportProblem } from './zip.ts'

/** The package every skill-filesystem config row mounts. */
const SKILL_PACKAGE = '@deepseek-ai/dsh-skill-filesystem'

// Precedence ranks, copied from dsh's skill-filesystem (project roots excluded).
const CUSTOM_RANK = 300
const USER_DSH_RANK = 400
const USER_AGENTS_RANK = 500
const BUNDLED_SKILL_RANK = 600

// ── config ───────────────────────────────────────────────────────────────────

/** The `config` of the `skill-filesystem` row in the home layer, if any. */
interface SkillFsConfig {
  includeDefaultRoots?: boolean
  dshHome?: string
  agentsHome?: string
  customSkillDirs?: string[]
  /** `customSkillDirs` entries written as `!!js` — dsh resolves them, we cannot. */
  runtimeDirs?: string[]
  bundledSkillDir?: string
}

/**
 * A configured path override, or `undefined` when it must be treated as unset.
 *
 * Three shapes LOOK configured and are not:
 *
 * - not a string — YAML `dshHome:` with no value parses to null, not `''`;
 * - the `!!js` SENTINEL: a string whose content is JavaScript source, so
 *   `resolve()` turns it into a path built from that source. Shipped presets write
 *   exactly this form, and for `dshHome` the damage is worse than a phantom root —
 *   it REPLACES the real writable root, so `user-dsh` (`<home>/skills`) vanishes
 *   from the list while a root nothing can write is reported as writable;
 * - blank (`''` or spaces): `resolve('')` is the process CWD, which EXISTS, so the
 *   scan would walk the launcher's own working directory and report whatever
 *   `SKILL.md` / `*.md` it finds as skills of this dsh.
 *
 * All four config path fields and both environment overrides go through this one
 * predicate. The value is returned as written (not trimmed) — only the decision is
 * made on the trimmed form, so a path's own bytes are never rewritten.
 */
function pathOverride(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  if (isJsExpr(value)) return undefined
  return value
}

/** Read the `@deepseek-ai/dsh-skill-filesystem` row's config from the home
 * layer. An absent row, or an unparsable one, means dsh's defaults apply.
 *
 * Every path field it reads goes through {@link pathOverride}: a `!!js` value is
 * dsh's to evaluate, never the launcher's to resolve. */
function readSkillFsConfig(ctx: DshContext): SkillFsConfig {
  const { text } = readHomePatch(ctx)
  const row = parseNamedRows(text).find(candidate => candidate.name === SKILL_PACKAGE)
  if (row === undefined) return {}
  const raw = extractKeyValue(text, row.id, 'config')
  if (raw === undefined) return {}
  let parsed: unknown
  try {
    parsed = loadYaml(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const config = parsed as Record<string, unknown>
  const out: SkillFsConfig = {}
  if (typeof config.includeDefaultRoots === 'boolean') out.includeDefaultRoots = config.includeDefaultRoots
  const dshHome = pathOverride(config.dshHome)
  if (dshHome !== undefined) out.dshHome = dshHome
  const agentsHome = pathOverride(config.agentsHome)
  if (agentsHome !== undefined) out.agentsHome = agentsHome
  if (Array.isArray(config.customSkillDirs)) {
    // A `!!js` entry parses to a SENTINEL-PREFIXED STRING, so a `typeof` filter
    // does not catch it — and resolving one yields a path built from JavaScript
    // source (verified: `resolve()` on the sentinel even normalises the slashes
    // inside the expression). Shipped presets write exactly this form, so it is
    // the common case, not an edge case.
    const dirs: string[] = []
    const runtime: string[] = []
    for (const value of config.customSkillDirs) {
      if (typeof value !== 'string') continue
      if (value.trim() === '') continue
      if (isJsExpr(value)) { runtime.push(jsExprText(value)); continue }
      dirs.push(value)
    }
    if (dirs.length > 0) out.customSkillDirs = dirs
    if (runtime.length > 0) out.runtimeDirs = runtime
  }
  const bundled = pathOverride(config.bundledSkillDir)
  if (bundled !== undefined) out.bundledSkillDir = bundled
  return out
}

/** The launcher's writable skill root: dsh resolves `dshHome` from its own
 * `DSH_HOME`, which the run path sets to `ctx.home`. */
export function writableSkillRoot(ctx: DshContext): string {
  return join(ctx.home, 'skills')
}

/** Which profile's composed layers to read preset-contributed roots from. Absent
 * means "this dsh, no profile" — the same convention `module-resolve.ts` uses,
 * and it yields no preset roots, since a preset is only meaningful inside one. */
export interface SkillRootOptions {
  profile?: string
}

/** Resolve every root dsh would scan for this dsh, sorted by rank. */
export function skillRoots(ctx: DshContext, opts: SkillRootOptions = {}): SkillRootInfo[] {
  const config = readSkillFsConfig(ctx)
  const includeDefault = config.includeDefaultRoots !== false
  const roots: SkillRootInfo[] = []
  const push = (
    root: string, source: SkillSource, rank: number, path: string, writable: boolean, runtime?: true,
  ): void => {
    // A runtime root's `path` is JavaScript source, not a filesystem path, so it
    // is never probed — the two facts are forced together rather than derived.
    roots.push(runtime === true
      ? { root, source, rank, path, exists: false, writable, runtime: true }
      : { root, source, rank, path, exists: existsSync(path), writable })
  }
  // Preset-contributed roots are `customSkillDirs` to the host too, so they sit
  // at custom rank. Their real order is whatever the selected preset's own row
  // says — a session fact the launcher has no standing to decide — so this
  // position is presentation only, and ties keep insertion order below.
  if (opts.profile !== undefined && opts.profile !== '') {
    for (const root of presetSkillRoots(ctx, opts.profile)) {
      push(`preset:${root.owner}`, 'preset', CUSTOM_RANK, root.path, false)
    }
  }
  ;(config.customSkillDirs ?? []).forEach((dir, i) => {
    push(`custom:${i}`, 'custom', CUSTOM_RANK, resolve(dir), false)
  })
  // Reported, never resolved: dsh evaluates these when it loads the row, so the
  // launcher knows a root EXISTS without knowing where. `exists: false` plus the
  // `runtime` flag keeps every scanner off them.
  ;(config.runtimeDirs ?? []).forEach((expression, i) => {
    push(`runtime:${i}`, 'custom', CUSTOM_RANK, expression, false, true)
  })
  if (includeDefault) {
    // dshHome: config override wins, else the launcher-set DSH_HOME (= ctx.home).
    const dshHome = config.dshHome !== undefined ? resolve(config.dshHome) : ctx.home
    // agentsHome: config override, then the launcher process env (the child
    // inherits it), then the dsh default `~/.agents`. `??` alone would accept an
    // EMPTY variable as configured — and `resolve('')` is this process's own
    // working directory, which exists, so the scan would walk the launcher's cwd.
    const agentsHome = config.agentsHome !== undefined
      ? resolve(config.agentsHome)
      : resolve(pathOverride(process.env.DSH_AGENTS_HOME) ?? join(homedir(), '.agents'))
    push('user-dsh', 'user-dsh', USER_DSH_RANK, join(dshHome, 'skills'), true)
    push('user-agents', 'user-agents', USER_AGENTS_RANK, join(agentsHome, 'skills'), false)
  }
  const bundled = config.bundledSkillDir ?? pathOverride(process.env.DSH_BUNDLED_SKILL_DIR)
  if (bundled !== undefined) push('bundled', 'bundled', BUNDLED_SKILL_RANK, resolve(bundled), false)
  return roots.sort((a, b) => a.rank - b.rank)
}

// ── listing ──────────────────────────────────────────────────────────────────

function toEntry(skill: ParsedSkill, info: SkillRootInfo, path: string, dir: string, shape: 'bundle' | 'flat'): SkillEntry {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
    modelInvocable: skill.modelInvocable,
    userInvocable: skill.userInvocable,
    source: info.source,
    rank: info.rank,
    path,
    dir,
    shape,
    editable: info.writable,
  }
}

/** Scan one root's entries the way dsh's `discoverRoot` does: a directory
 * contributes `<name>/SKILL.md`, a `.md` file contributes itself. Files dsh
 * would ignore become issues instead of being silently dropped.
 *
 * The read is guarded per file: `scanRoot` walks a whole root inside one call, so
 * a file that cannot be read — a half-removed copy, a directory where the entry
 * claims a file, a permission change — would otherwise fail the entire catalog
 * and every other skill in it. A file dsh also cannot read is a file dsh does
 * not load, which is exactly what an issue says. */
function scanRoot(info: SkillRootInfo, skills: SkillEntry[], issues: SkillIssue[]): void {
  let entries
  try {
    entries = readdirSync(info.path, { withFileTypes: true })
  } catch {
    issues.push({ path: info.path, source: info.source, reason: 'root is not readable' })
    return
  }
  /** Read and parse one file, reporting an unreadable one as an issue. */
  const take = (file: string, dir: string, shape: 'bundle' | 'flat'): void => {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      issues.push({
        path: file,
        source: info.source,
        reason: `the file cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    const parsed = parseSkillText(text)
    if (parsed.ok) skills.push(toEntry(parsed.skill, info, file, dir, shape))
    else issues.push({ path: file, source: info.source, reason: parsed.reason })
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (info.source === 'user-dsh' && entry.name === '.system') continue
    if (entry.isDirectory()) {
      const file = join(info.path, entry.name, 'SKILL.md')
      if (!existsSync(file)) continue
      take(file, join(info.path, entry.name), 'bundle')
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      take(join(info.path, entry.name), info.path, 'flat')
    }
  }
}

/** The full skill picture for one dsh: roots, discovered catalog (rank order),
 * and every skill-like file that would not load, with the reason. */
export function listSkills(ctx: DshContext, opts: SkillRootOptions = {}): SkillListing {
  const roots = skillRoots(ctx, opts)
  const skills: SkillEntry[] = []
  const issues: SkillIssue[] = []
  for (const info of roots) {
    // `exists: false` already keeps these out; the explicit check makes the rule
    // independent of that coupling, since a future caller could report otherwise.
    if (!info.exists || info.runtime === true) continue
    scanRoot(info, skills, issues)
  }
  skills.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
  return { roots, skills, issues }
}

// ── write / delete (writable root only) ──────────────────────────────────────

/** The injected OS-recycle-bin move; main wires `shell.trashItem`, tests a fake. */
let trash: ((target: string) => Promise<void>) | null = null

/** Inject the recycle-bin mover (main process wires shell.trashItem). */
export function setSkillTrash(next: ((target: string) => Promise<void>) | null): void {
  trash = next
}

/** One editable entry: a skill living in the writable user-dsh root. */
interface WritableSkill {
  entry: SkillEntry
}
/** Find the skill named `name` among the editable entries, or `undefined`.
 * `editable` already implies the writable user-dsh root. */
export function findEditableSkill(ctx: DshContext, name: string): WritableSkill | undefined {
  for (const entry of listSkills(ctx).skills) {
    if (entry.name === name && entry.editable) return { entry }
  }
  return undefined
}

/** The bundle dir + file a skill named `name` occupies in the writable root. */
function targetPaths(ctx: DshContext, name: string): { dir: string; file: string } {
  const dir = join(writableSkillRoot(ctx), name)
  return { dir, file: join(dir, 'SKILL.md') }
}

/** Read the full text of an editable skill (for the editor modal). */
export function readSkillFile(ctx: DshContext, name: string): string {
  const found = findEditableSkill(ctx, name)
  // A business refusal, not an internal error: the name may be perfectly real and
  // simply live in a read-only root (project / custom / agents / bundled).
  if (found === undefined) throwE(E.extSkillReadOnly, { detail: name })
  return readFileSync(found.entry.path, 'utf8')
}

/**
 * Create or update a skill in the writable root from full file text.
 *
 * The frontmatter `name` is authoritative: editing it renames the bundle dir
 * (an existing dir with the old name moves first, same root so a plain rename).
 * Writing over a name that exists in a higher-precedence root is allowed — dsh
 * resolves first-wins by rank, so the writable copy simply never shows — and
 * the caller may warn.
 */
export function writeSkill(ctx: DshContext, previousName: string | null, text: string): SkillEntry {
  const parsed = parseSkillText(text)
  if (!parsed.ok) throw new Error(parsed.reason)
  const name = parsed.skill.name
  const { dir, file } = targetPaths(ctx, name)
  const previous = previousName !== null ? findEditableSkill(ctx, previousName) : undefined
  if (previousName !== null && previous === undefined) {
    throwE(E.extSkillReadOnly, { detail: previousName })
  }
  const renaming = previousName !== null && previousName !== name
  if (renaming && findEditableSkill(ctx, name) !== undefined) {
    throw new Error(`skill "${name}" already exists in the writable root`)
  }
  // A FRESH create must not land on top of a skill that is already in the writable
  // root. The editor cannot see it — there is nothing to read yet, so the caller
  // has no name to pass as `previousName` — and without this check the new text
  // silently replaced an existing SKILL.md. A flat `<name>.md` needs the same
  // refusal: a bundle beside it would be two skills under one name, and dsh takes
  // whichever it scans first. An in-place edit (the entry that IS there) and a
  // rename (refused above) are the only ways past this.
  if (previousName === null) {
    const root = writableSkillRoot(ctx)
    if (existsSync(join(root, name)) || existsSync(join(root, `${name}.md`))) {
      throwE(E.extSkillExists, { detail: name })
    }
  }
  if (previous !== undefined && renaming && previous.entry.shape === 'bundle') {
    // Plain rename within the same root; the destination must not exist.
    renameSync(previous.entry.dir, dir)
  } else if (previous !== undefined && renaming) {
    // A flat `<old>.md` becomes a bundle: the file moves inside the new dir.
    mkdirSync(dir, { recursive: true })
    renameSync(previous.entry.path, file)
  } else {
    // Fresh creation, or an in-place edit (same name): for the latter the
    // bundle dir already exists — keep it and all of its resource files.
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(file, text)
  if (readFileSync(file, 'utf8') !== text) throw new Error('write verify failed')
  // An in-place edit of a flat `<name>.md` entry just became a bundle — drop
  // the flat file so the root does not keep two same-named skills.
  if (previousName === name) rmSync(join(writableSkillRoot(ctx), `${name}.md`), { force: true })
  logger.info(`skills: wrote ${file}`)
  return installedEntry(parsed.skill, writableSkillRoot(ctx))
}

/** Move an editable skill to the OS recycle bin. Resolves the entry itself so
 * the caller can never trash a path outside the writable root. */
export async function deleteSkill(ctx: DshContext, name: string): Promise<void> {
  const found = findEditableSkill(ctx, name)
  if (found === undefined) throwE(E.extSkillReadOnly, { detail: name })
  if (trash === null) throw new Error('skill trash mover is not wired')
  const target = found.entry.shape === 'bundle' ? found.entry.dir : found.entry.path
  await trash(target)
  logger.info(`skills: moved to recycle bin ${target}`)
}

/** Install every skill a zip carries into the dsh's writable root. */
export function importSkillZip(ctx: DshContext, zipPath: string): SkillEntry[] {
  const rootDir = writableSkillRoot(ctx)
  return installZipSkills(rootDir, zipPath, name => findEditableSkill(ctx, name) !== undefined)
    .map(({ skill }) => installedEntry(skill, rootDir))
}

/** The home-layer patch path a `skill-filesystem` config row lives in (for docs/UX). */

/** The catalog entry for a skill just installed into `root`, in the shape it
 * landed as (`bundle` → `<name>/SKILL.md`, `flat` → `<name>.md`). */
export function installedEntry(skill: ParsedSkill, root: string, shape: 'bundle' | 'flat' = 'bundle'): SkillEntry {
  // A flat skill IS the `.md` file at the root, so its dir is the root itself
  // (same convention `listSkills` uses for a discovered `<name>.md`).
  const dir = shape === 'flat' ? root : join(root, skill.name)
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
    modelInvocable: skill.modelInvocable,
    userInvocable: skill.userInvocable,
    source: 'user-dsh',
    rank: USER_DSH_RANK,
    path: shape === 'flat' ? join(root, `${skill.name}.md`) : join(dir, 'SKILL.md'),
    dir,
    shape,
    editable: true,
  }
}
