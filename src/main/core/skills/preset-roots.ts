/**
 * The skill roots a PRESET contributes.
 *
 * A preset carries skills, but never as a field of its own: the host has no such
 * field, so it mounts them through the same `skill-filesystem` row every other
 * composition uses, with `customSkillDirs` pointing at a directory the preset
 * ships. Verified against the shipped presets of both models — the directory
 * model's `presets/cordis/agent.cordis.yml` resolves `new URL('skills/', baseUrl)`
 * beside its own composition, and the declaration model's
 * `presets/cordis.patch.yml` resolves `@deepseek-ai/dsh-agent-preset`'s own
 * `skills/` through `require.resolve`.
 *
 * Those two expressions are `!!js`, and the launcher deliberately does not
 * evaluate them: `patch/yaml.ts` only carries such a value through as a
 * sentinel-prefixed string, so guessing at it produced paths built from
 * JavaScript source. Instead this module enumerates by CONVENTION — the two
 * layouts the shipped presets establish — and reports what it finds. A preset
 * that points its `customSkillDirs` somewhere else stays invisible here, which
 * is stated rather than papered over: a root the launcher cannot resolve is
 * reported by `skillRoots` as a runtime root, not silently dropped.
 *
 * Both conventions are profile-scoped (the declaration model's package resolves
 * through the profile's own chain, and a directory roster is per dsh but its
 * presets are what a profile composes), so a caller without a profile gets none.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DECLARATION_PLUGIN } from '../../../shared/preset.ts'
import { detectModel, profileLayers } from '../presets/layers.ts'
import { discoverPresets, presetRoots } from '../presets/roots.ts'
import { resolveModule } from '../store/module-resolve.ts'
import type { DshContext } from '../profile/appState.ts'

/** The directory a preset ships its skills in, beside its composition. */
const PRESET_SKILLS_SUBDIR = 'skills'

/** One root a preset brings, and which preset brought it. */
export interface PresetSkillRoot {
  /** Absolute path of the root, when the launcher could resolve it. */
  path: string
  /** Who contributed it: a preset id (directory model) or the package name. */
  owner: string
}

/**
 * Every skill root the presets of one profile contribute, deduplicated by path.
 *
 * Read-only and unmemoized, like `presetRoots`/`discoverPresets` themselves: a
 * preset authored while the launcher runs must appear on the next read.
 * @param ctx - the dsh to read.
 * @param profile - the profile whose composed layers decide the model.
 * @returns the roots, or `[]` when the profile composes no preset model.
 */
export function presetSkillRoots(ctx: DshContext, profile: string): PresetSkillRoot[] {
  if (profile === '') return []
  const found: PresetSkillRoot[] = []
  const seen = new Set<string>()
  const add = (owner: string, dir: string): void => {
    if (!existsSync(dir) || seen.has(dir)) return
    seen.add(dir)
    found.push({ path: dir, owner })
  }

  switch (detectModel(profileLayers(ctx, profile))) {
    case 'directory':
      // The shipped built-ins and any locally authored preset both live in a
      // directory whose composition sits beside `skills/`.
      for (const preset of discoverPresets(presetRoots(ctx))) {
        add(preset.id, join(preset.dir, PRESET_SKILLS_SUBDIR))
      }
      break
    case 'declaration': {
      // Every declaration built on the host's preset package resolves that
      // package's own `skills/`, so one root serves the whole roster.
      const pkg = resolveModule(ctx, DECLARATION_PLUGIN, { profile })
      if (pkg !== undefined && pkg.state === 'ok') {
        add(DECLARATION_PLUGIN, join(pkg.dir, PRESET_SKILLS_SUBDIR))
      }
      break
    }
    default:
      break
  }
  return found
}