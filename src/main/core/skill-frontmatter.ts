/**
 * A skill file's frontmatter: reading it the way dsh does, and rendering one back.
 *
 * Pure — text in, value out. No filesystem and no dsh context, so every rule about
 * what dsh will and will not accept is readable on its own.
 */


import { join } from 'node:path'
import { loadYaml } from './yaml.ts'
import { logger } from './logger.ts'
import { SKILL_NAME_RE } from '../../shared/skill.ts'



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
