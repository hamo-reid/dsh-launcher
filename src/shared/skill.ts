/**
 * Skill rules shared by main and renderer.
 *
 * dsh's `skill-filesystem` provider only catalogs skills whose frontmatter
 * `name` matches this regex (lowercase kebab-case); see deepseek-harness
 * packages/skill/skill (`isSkillName`).
 */

/** The name rule a skill's frontmatter must satisfy. */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The label a preset-contributed skill root carries: `preset:<owner>`.
 *
 * dsh has no field for "a preset brings skills" — a preset mounts them through
 * the same `skill-filesystem` row as everything else — so `core/skills/skills.ts`
 * invents this label to say WHICH preset brought a root. The renderer reads the
 * owner back out of it, so both sides spell it here rather than in two places. */
export const PRESET_SKILL_ROOT_PREFIX = 'preset:'

/** The label for a root contributed by `owner` (a preset id, or the declaring
 * package's name). */
export function presetSkillRootLabel(owner: string): string {
  return `${PRESET_SKILL_ROOT_PREFIX}${owner}`
}

/** The owner inside such a label, or `''` when the label is not one. */
export function presetSkillRootOwner(label: string): string {
  return label.startsWith(PRESET_SKILL_ROOT_PREFIX) ? label.slice(PRESET_SKILL_ROOT_PREFIX.length) : ''
}

