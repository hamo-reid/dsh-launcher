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
import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { homePatchPath, readHomePatch } from './home.ts'
import { extractKeyValue, parseNamedRows } from './patch.ts'
import { loadYaml } from './yaml.ts'
import { logger } from './logger.ts'
import { E, throwE } from './errors.ts'
import { SKILL_NAME_RE } from '../../shared/skill.ts'
import type { DshContext } from './appState.ts'
import type { SkillEntry, SkillIssue, SkillListing, SkillRootInfo, SkillSource } from '../../shared/types.ts'

/** The package every skill-filesystem config row mounts. */
export const SKILL_PACKAGE = '@deepseek-ai/dsh-skill-filesystem'

// Precedence ranks, copied from dsh's skill-filesystem (project roots excluded).
const CUSTOM_RANK = 300
const USER_DSH_RANK = 400
const USER_AGENTS_RANK = 500
const BUNDLED_SKILL_RANK = 600

/** The parsed frontmatter of one skill file (mirrors dsh's `ParsedSkill`). */
export interface ParsedSkill {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  /** Body after the closing `---`, trimmed (dsh trims it too). */
  body: string
}

// ── config ───────────────────────────────────────────────────────────────────

/** The `config` of the `skill-filesystem` row in the home layer, if any. */
export interface SkillFsConfig {
  includeDefaultRoots?: boolean
  dshHome?: string
  agentsHome?: string
  customSkillDirs?: string[]
  bundledSkillDir?: string
}

/** Read the `@deepseek-ai/dsh-skill-filesystem` row's config from the home
 * layer. An absent row, or an unparsable one, means dsh's defaults apply. */
export function readSkillFsConfig(ctx: DshContext): SkillFsConfig {
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
  if (typeof config.dshHome === 'string' && config.dshHome !== '') out.dshHome = config.dshHome
  if (typeof config.agentsHome === 'string' && config.agentsHome !== '') out.agentsHome = config.agentsHome
  if (Array.isArray(config.customSkillDirs)) {
    const dirs = config.customSkillDirs.filter((v): v is string => typeof v === 'string' && v !== '')
    if (dirs.length > 0) out.customSkillDirs = dirs
  }
  if (typeof config.bundledSkillDir === 'string' && config.bundledSkillDir !== '') out.bundledSkillDir = config.bundledSkillDir
  return out
}

/** The launcher's writable skill root: dsh resolves `dshHome` from its own
 * `DSH_HOME`, which the run path sets to `ctx.home`. */
export function writableSkillRoot(ctx: DshContext): string {
  return join(ctx.home, 'skills')
}

/** Resolve every root dsh would scan for this dsh, sorted by rank. */
export function skillRoots(ctx: DshContext): SkillRootInfo[] {
  const config = readSkillFsConfig(ctx)
  const includeDefault = config.includeDefaultRoots !== false
  const roots: SkillRootInfo[] = []
  const push = (root: string, source: SkillSource, rank: number, path: string, writable: boolean): void => {
    roots.push({ root, source, rank, path, exists: existsSync(path), writable })
  }
  ;(config.customSkillDirs ?? []).forEach((dir, i) => {
    push(`custom:${i}`, 'custom', CUSTOM_RANK, resolve(dir), false)
  })
  if (includeDefault) {
    // dshHome: config override wins, else the launcher-set DSH_HOME (= ctx.home).
    const dshHome = config.dshHome !== undefined ? resolve(config.dshHome) : ctx.home
    // agentsHome: config override, then the launcher process env (the child
    // inherits it), then the dsh default `~/.agents`.
    const agentsHome = config.agentsHome !== undefined
      ? resolve(config.agentsHome)
      : resolve(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))
    push('user-dsh', 'user-dsh', USER_DSH_RANK, join(dshHome, 'skills'), true)
    push('user-agents', 'user-agents', USER_AGENTS_RANK, join(agentsHome, 'skills'), false)
  }
  const bundled = config.bundledSkillDir ?? process.env.DSH_BUNDLED_SKILL_DIR
  if (bundled !== undefined) push('bundled', 'bundled', BUNDLED_SKILL_RANK, resolve(bundled), false)
  return roots.sort((a, b) => a.rank - b.rank)
}

// ── parse / render ───────────────────────────────────────────────────────────

interface Frontmatter {
  data: Record<string, unknown>
  body: string
}

/** Split a `---` fenced frontmatter (mirrors dsh's `parseFrontmatter`, CRLF
 * tolerant). `undefined` when the file does not open with a closed fence. */
function splitFrontmatter(text: string): Frontmatter | undefined {
  const firstLf = text.indexOf('\n')
  if (firstLf < 0) return undefined
  if (text.slice(0, firstLf).replace(/\r$/, '') !== '---') return undefined
  let pos = firstLf + 1
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos)
    const end = nl < 0 ? text.length : nl
    if (text.slice(pos, end).replace(/\r$/, '') === '---') {
      return { data: yamlMap(text.slice(firstLf + 1, pos)), body: nl < 0 ? '' : text.slice(nl + 1) }
    }
    if (nl < 0) return undefined
    pos = nl + 1
  }
  return undefined
}

function yamlMap(yaml: string): Record<string, unknown> {
  const parsed = loadYaml(yaml)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frontmatter is not a mapping')
  }
  return parsed as Record<string, unknown>
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Boolean-ish frontmatter values dsh accepts (`true`/`1`/`'yes'`/…); a
 * present-but-unparseable value is an error, mirroring dsh. */
function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true': case 'yes': case 'on': return true
      case 'false': case 'no': case 'off': return false
    }
  }
  throw new Error(`frontmatter field "${key}" must be a boolean`)
}

/** The invocation policy: `disable-model-invocation` and `user-invocable`. The
 * camelCase legacy names dsh rejects are rejected here too, so a file the
 * launcher accepts is one dsh loads. */
function parseInvocationPolicy(data: Record<string, unknown>): { modelInvocable: boolean; userInvocable: boolean } {
  for (const [legacy, canonical] of [
    ['disableModelInvocation', 'disable-model-invocation'],
    ['modelInvocable', 'disable-model-invocation'],
    ['userInvocable', 'user-invocable'],
  ] as const) {
    if (Object.hasOwn(data, legacy)) {
      throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
    }
  }
  const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

/**
 * Parse one skill file's text with dsh's exact acceptance rules. Every failure
 * mode dsh ignores a file for is a named reason here, so the launcher can show
 * why a file is not in the catalog.
 */
export function parseSkillText(text: string): { ok: true; skill: ParsedSkill } | { ok: false; reason: string } {
  let frontmatter: Frontmatter
  try {
    const split = splitFrontmatter(text)
    if (split === undefined) return { ok: false, reason: 'missing YAML frontmatter (the file must open with --- and close with ---)' }
    frontmatter = split
  } catch (error) {
    return { ok: false, reason: `invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}` }
  }
  const name = stringField(frontmatter.data, 'name')
  const description = stringField(frontmatter.data, 'description')
  if (name === undefined || description === undefined) {
    return { ok: false, reason: 'frontmatter requires non-empty name and description' }
  }
  if (!SKILL_NAME_RE.test(name)) {
    return { ok: false, reason: `invalid skill name "${name}" — use lowercase kebab-case ([a-z0-9]+(?:-[a-z0-9]+)*)` }
  }
  let invocation: { modelInvocable: boolean; userInvocable: boolean }
  try {
    invocation = parseInvocationPolicy(frontmatter.data)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  return {
    ok: true,
    skill: {
      name,
      description,
      ...stringField(frontmatter.data, 'whenToUse') !== undefined ? { whenToUse: stringField(frontmatter.data, 'whenToUse') } : {},
      ...invocation,
      body: frontmatter.body.trim(),
    },
  }
}

/** A YAML string rendered the way the launcher's scaffold writes one: bare when
 * unambiguous, single-quoted otherwise, block scalar for multi-line values. */
function yamlString(value: string): string {
  if (value.includes('\n')) {
    return `|-\n${value.split('\n').map(line => `  ${line}`).join('\n')}`
  }
  if (/^[A-Za-z0-9_][A-Za-z0-9_ ./-]*$/.test(value) && !/^(true|false|null|yes|no|on|off)$/i.test(value)) {
    return value
  }
  return `'${value.replace(/'/g, "''")}'`
}

/** Render a whole SKILL.md: frontmatter + body, in the shape dsh parses. */
export function renderSkillFile(input: Pick<ParsedSkill, 'name' | 'description' | 'whenToUse' | 'modelInvocable' | 'userInvocable' | 'body'>): string {
  const lines = ['---', `name: ${input.name}`, `description: ${yamlString(input.description)}`]
  if (input.whenToUse !== undefined && input.whenToUse !== '') lines.push(`whenToUse: ${yamlString(input.whenToUse)}`)
  if (!input.modelInvocable) lines.push('disable-model-invocation: true')
  if (!input.userInvocable) lines.push('user-invocable: false')
  lines.push('---', '', input.body.trim())
  return `${lines.join('\n')}\n`
}

/** A scaffold for a new skill, ready for the editor. The placeholder
 * description parses, so saving the untouched scaffold is valid. */
export function scaffoldSkill(name: string): string {
  return renderSkillFile({
    name,
    description: `TODO: describe what ${name} does and when to use it`,
    modelInvocable: true,
    userInvocable: true,
    body: '',
  })
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
 * would ignore become issues instead of being silently dropped. */
function scanRoot(info: SkillRootInfo, skills: SkillEntry[], issues: SkillIssue[]): void {
  let entries
  try {
    entries = readdirSync(info.path, { withFileTypes: true })
  } catch {
    issues.push({ path: info.path, source: info.source, reason: 'root is not readable' })
    return
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (info.source === 'user-dsh' && entry.name === '.system') continue
    if (entry.isDirectory()) {
      const file = join(info.path, entry.name, 'SKILL.md')
      if (!existsSync(file)) continue
      const parsed = parseSkillText(readFileSync(file, 'utf8'))
      if (parsed.ok) skills.push(toEntry(parsed.skill, info, file, join(info.path, entry.name), 'bundle'))
      else issues.push({ path: file, source: info.source, reason: parsed.reason })
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const file = join(info.path, entry.name)
      const parsed = parseSkillText(readFileSync(file, 'utf8'))
      if (parsed.ok) skills.push(toEntry(parsed.skill, info, file, info.path, 'flat'))
      else issues.push({ path: file, source: info.source, reason: parsed.reason })
    }
  }
}

/** The full skill picture for one dsh: roots, discovered catalog (rank order),
 * and every skill-like file that would not load, with the reason. */
export function listSkills(ctx: DshContext): SkillListing {
  const roots = skillRoots(ctx)
  const skills: SkillEntry[] = []
  const issues: SkillIssue[] = []
  for (const info of roots) {
    if (!info.exists) continue
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
export interface WritableSkill {
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
  if (found === undefined) throw new Error(`skill "${name}" is not editable (not in the writable root)`)
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
  const previous = previousName !== null && previousName !== name ? findEditableSkill(ctx, previousName) : undefined
  if (previousName !== null && previous === undefined) {
    throw new Error(`skill "${previousName}" is not editable (not in the writable root)`)
  }
  if (previous !== undefined && findEditableSkill(ctx, name) !== undefined) {
    throw new Error(`skill "${name}" already exists in the writable root`)
  }
  if (previous !== undefined && previous.entry.shape === 'bundle') {
    // Plain rename within the same root; the destination must not exist.
    renameSync(previous.entry.dir, dir)
  } else if (previous !== undefined) {
    // A flat `<old>.md` becomes a bundle: the file moves inside the new dir.
    mkdirSync(dir, { recursive: true })
    renameSync(previous.entry.path, file)
  } else {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(file, text)
  if (readFileSync(file, 'utf8') !== text) throw new Error('write verify failed')
  logger.info(`skills: wrote ${file}`)
  return installedEntry(parsed.skill, writableSkillRoot(ctx))
}

/** Move an editable skill to the OS recycle bin. Resolves the entry itself so
 * the caller can never trash a path outside the writable root. */
export async function deleteSkill(ctx: DshContext, name: string): Promise<void> {
  const found = findEditableSkill(ctx, name)
  if (found === undefined) throw new Error(`skill "${name}" is not editable (not in the writable root)`)
  if (trash === null) throw new Error('skill trash mover is not wired')
  const target = found.entry.shape === 'bundle' ? found.entry.dir : found.entry.path
  await trash(target)
  logger.info(`skills: moved to recycle bin ${target}`)
}

// ── zip import ───────────────────────────────────────────────────────────────

/** The catalog entry for a skill just installed into the writable root. */
function installedEntry(skill: ParsedSkill, root: string): SkillEntry {
  const dir = join(root, skill.name)
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
    modelInvocable: skill.modelInvocable,
    userInvocable: skill.userInvocable,
    source: 'user-dsh',
    rank: USER_DSH_RANK,
    path: join(dir, 'SKILL.md'),
    dir,
    shape: 'bundle',
    editable: true,
  }
}

/** Zip-slip guard: reject absolute paths, drive prefixes, and `..` segments
 * (backslashes normalized first — Windows-made archives use them). Exported
 * for tests: adm-zip normalizes hostile names on WRITE, so a slip entry can
 * only reach this guard from a third-party archive on READ. */
export function zipEntryUnsafe(entryName: string): boolean {
  const path = entryName.replaceAll('\\', '/')
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return true
  return path.split('/').some(segment => segment === '..')
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
 * Install every skill a zip carries into the writable root, all-or-nothing.
 *
 * The archive is extracted to a temp staging dir; every candidate is parsed and
 * collision-checked (against the writable root AND the other candidates) BEFORE
 * anything is installed, so a failure leaves the root untouched. The installed
 * directory name is the frontmatter `name` — the same authority as the editor —
 * and the skill's own directory (scripts, references, …) is carried over whole.
 */
export function importSkillZip(ctx: DshContext, zipPath: string): SkillEntry[] {
  const arc = new AdmZip(zipPath)
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
      if (seen.has(name) || findEditableSkill(ctx, name) !== undefined) {
        throwE(E.extSkillExists, { detail: name })
      }
      seen.add(name)
      installs.push({ skill: parsed.skill, from: join(staging, dir) })
    }
    // Pass 2 — install (renames inside staging → writable root).
    const root = writableSkillRoot(ctx)
    mkdirSync(root, { recursive: true })
    return installs.map(({ skill, from }) => {
      renameSync(from, join(root, skill.name))
      return installedEntry(skill, root)
    })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** The home-layer patch path a `skill-filesystem` config row lives in (for docs/UX). */
export function skillConfigPath(ctx: DshContext): string {
  return homePatchPath(ctx)
}
