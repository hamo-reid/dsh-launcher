/**
 * Profile-name rules shared by the main process and the renderer, so both agree
 * on what a valid, non-reserved profile name is.
 */

/**
 * Names the host reserves for its shipped profile templates (the keys of
 * `PROFILE_TEMPLATES` in `@deepseek-ai/dsh-app-boot`). A custom profile with one
 * of these names is treated as shipped by the host: `loadProfile` auto-inits it
 * from the template when missing, and `normalizeShippedProfile` rewrites an
 * exact template bundle tuple. Creating a custom profile under such a name is
 * therefore refused — the name means "the shipped template", not "my profile".
 */
export const RESERVED_PROFILE_NAMES: readonly string[] = ['acp', 'web', 'headless', 'sdk', 'sdk-minimal']

/** True when `name` collides with a host-shipped profile template. */
export function isReservedProfileName(name: string): boolean {
  return RESERVED_PROFILE_NAMES.includes(name)
}

/** The kebab-case rule the launcher enforces for custom profile names. */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/
