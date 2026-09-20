/**
 * Skill rules shared by main and renderer.
 *
 * dsh's `skill-filesystem` provider only catalogs skills whose frontmatter
 * `name` matches this regex (lowercase kebab-case); see deepseek-harness
 * packages/skill/skill (`isSkillName`).
 */

/** The name rule a skill's frontmatter must satisfy. */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
