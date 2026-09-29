/**
 * Agent-preset rules shared by main and renderer.
 *
 * dsh has shipped TWO preset models, and the launcher supports both:
 *
 * - The DIRECTORY model (through 0.1.5-rc.2) — a preset is a directory:
 *   `agent.cordis.yml` is its composition and is what makes the directory a
 *   preset at all, `preset.yml` carries its display text, and the directory name
 *   is its id. dsh discovers them under its own roots, the built-in set inside
 *   the installed `dsh-agent-presets` package then locally authored ones under
 *   `<dsh home>/.agent-presets`.
 * - The DECLARATION model (0.2.0-rc.1 and later) — a preset is a ROW of
 *   `@deepseek-ai/dsh-agent-preset` in an ordinary Cordis patch layer, with the
 *   plugin entry list in `config.plugins` and the display text in
 *   `config.name` / `config.description` / `config.order`. Nothing reads a
 *   preset directory any more; the package's own docs say so outright.
 *
 * Which model a profile uses is decided by WHICH of these plugin packages the
 * profile's composition mounts — never by comparing version numbers, because a
 * version tells you what was installed, not what is composed.
 */

/**
 * The directory-name rule a preset id must satisfy (the host's `PRESET_ID`).
 *
 * The id becomes a path segment, so this is a containment boundary rather than
 * a style rule: `..`, a separator, or an absolute-looking name would place the
 * composition outside the root that owns it. The host applies the same rule to
 * discovery, so a directory named outside it is not a preset slot at all. The
 * declaration model's host documents the same shape for `config.id`.
 */
export const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/

/** The composition file that makes a directory a preset (directory model). */
export const COMPOSITION_FILE = 'agent.cordis.yml'

/** The optional display-metadata file beside a preset's composition (directory model). */
export const METADATA_FILE = 'preset.yml'

/** The harness-home directory holding locally authored presets (directory model). */
export const USER_PRESET_DIR = '.agent-presets'

/** The package whose own `presets/` directory ships the built-in set (directory model). */
export const PRESET_PACKAGE = '@deepseek-ai/dsh-agent-presets'

/** The built-in preset directory inside {@link PRESET_PACKAGE}. */
export const PRESET_ROOT_SUBDIR = 'presets'

/** The row plugin that declares one preset (declaration model). */
export const DECLARATION_PLUGIN = '@deepseek-ai/dsh-agent-preset'

/** The registry row that owns selection and revisions (declaration model). */
export const DECLARATION_REGISTRY_PLUGIN = '@deepseek-ai/dsh-agent-preset-registry'

/** Which preset model a profile's composition mounts. */
export type PresetModel = 'directory' | 'declaration' | 'none'

