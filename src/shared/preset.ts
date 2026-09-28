/**
 * Agent-preset rules shared by main and renderer.
 *
 * A preset is a DIRECTORY: `agent.cordis.yml` is its composition and is what
 * makes the directory a preset at all, `preset.yml` carries its display text,
 * and the directory name is its id. dsh discovers them under its own roots —
 * the built-in set inside the installed `dsh-agent-presets` package, then
 * locally authored ones under `<dsh home>/.agent-presets`; see deepseek-harness
 * packages/preset/agent-presets (`discovery.ts`, `metadata.ts`, `preset.ts`).
 */

/**
 * The directory-name rule a preset id must satisfy (the host's `PRESET_ID`).
 *
 * The id becomes a path segment, so this is a containment boundary rather than
 * a style rule: `..`, a separator, or an absolute-looking name would place the
 * composition outside the root that owns it. The host applies the same rule to
 * discovery, so a directory named outside it is not a preset slot at all.
 */
export const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/

/** The composition file that makes a directory a preset. */
export const COMPOSITION_FILE = 'agent.cordis.yml'

/** The optional display-metadata file beside a preset's composition. */
export const METADATA_FILE = 'preset.yml'

/** The harness-home directory holding locally authored presets. */
export const USER_PRESET_DIR = '.agent-presets'

/** The package whose own `presets/` directory ships the built-in set. */
export const PRESET_PACKAGE = '@deepseek-ai/dsh-agent-presets'

/** The built-in preset directory inside {@link PRESET_PACKAGE}. */
export const PRESET_ROOT_SUBDIR = 'presets'
