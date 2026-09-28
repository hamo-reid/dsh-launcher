/**
 * Where one dsh's agent presets live, and which of them it discovers.
 *
 * Two roots, in the host's own precedence order: the built-in set that travels
 * inside the installed `dsh-agent-presets` package (`trust: 'system'`), and the
 * locally authored `~/.agent-presets` under the dsh's home (`trust: 'user'`) —
 * the only writable one. An earlier root wins a duplicate id, so a directory
 * that claims a built-in preset's name is shadowed by it, exactly as it is at
 * mount time.
 *
 * Discovery is unmemoized on purpose, like the host's: it re-reads the roots on
 * every call, so a preset authored while the launcher runs appears immediately
 * and one deleted underneath a list disappears from the next read.
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import {
  COMPOSITION_FILE, PRESET_ID_RE, PRESET_PACKAGE, PRESET_ROOT_SUBDIR, USER_PRESET_DIR,
} from '../../../shared/preset.ts'
import { resolveModule } from '../store/module-resolve.ts'
import { readPresetMetadata } from './metadata.ts'
import { readComposition } from './rows.ts'
import type { DshContext } from '../profile/appState.ts'
import type { PresetRootInfo, PresetRow } from '../../../shared/types.ts'

/** The dsh's writable preset root: `<home>/.agent-presets`, which is where dsh
 * looks for a locally authored preset (the launcher sets the child's `DSH_HOME`
 * to `ctx.home`). */
export function userPresetRoot(ctx: DshContext): string {
  return join(ctx.home, USER_PRESET_DIR)
}

/** The built-in preset root, or undefined when the package is not installed.
 *
 * Resolved through the install's own Node lookup chain, not as
 * `<install>/node_modules/<name>`: a pnpm install keeps every package but `dsh`
 * under `.pnpm/<pkg>@<ver>_<hash>/node_modules`, so the plain probe would report
 * the built-in set as absent on a real install. */
export function shippedPresetRoot(ctx: DshContext): string | undefined {
  const found = resolveModule(ctx, PRESET_PACKAGE)
  if (found === undefined || found.state !== 'ok') return undefined
  const dir = join(found.dir, PRESET_ROOT_SUBDIR)
  return existsSync(dir) ? dir : undefined
}

/**
 * The roots this dsh's roster is composed from, in precedence order.
 * @param ctx - the dsh to read.
 * @returns the built-in root (when the package is installed) then the user root.
 */
export function presetRoots(ctx: DshContext): PresetRootInfo[] {
  const roots: PresetRootInfo[] = []
  const shipped = shippedPresetRoot(ctx)
  if (shipped !== undefined) {
    roots.push({ path: shipped, trust: 'system', exists: true, writable: false })
  }
  const user = userPresetRoot(ctx)
  roots.push({ path: user, trust: 'user', exists: existsSync(user), writable: true })
  return roots
}

/**
 * Why the composition at `path` cannot mount, or undefined when it looks
 * loadable. Mirrors the host's `compositionProblem`: a missing file and an
 * unloadable one are different sentences, because the fixes differ.
 * @param path - absolute path of the composition file.
 * @returns one human-readable reason, or undefined when the file is loadable.
 */
export function compositionProblem(path: string): string | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return existsSync(path)
      ? `the composition file ${COMPOSITION_FILE} cannot be read`
      : `the composition file ${COMPOSITION_FILE} is missing — the directory still occupies the id; delete it or restore the file`
  }
  const read = readComposition(text)
  return read.ok ? undefined : read.problem
}

/**
 * Scan one root for preset directories.
 *
 * Every directory whose name is a usable preset id is a row — broken when its
 * composition is missing or unloadable, because a skipped directory would still
 * occupy its id while nothing showed anything to fix. A directory named outside
 * {@link PRESET_ID_RE} is skipped instead: no preset could ever claim that name,
 * so it blocks nothing, and reporting editor droppings as broken presets would
 * teach users to ignore the marker.
 * @param root - the root to scan.
 * @returns the root's presets, ordered by declared priority then id.
 */
function scanRoot(root: PresetRootInfo): PresetRow[] {
  let children: Dirent[]
  try {
    children = readdirSync(root.path, { withFileTypes: true })
  } catch {
    // An absent root is the normal state of the user root before the first
    // locally authored preset, and an unreadable one offers nothing to show.
    return []
  }
  const found: PresetRow[] = []
  for (const child of children) {
    if (!child.isDirectory() || !PRESET_ID_RE.test(child.name)) continue
    const dir = join(root.path, child.name)
    const compositionPath = join(dir, COMPOSITION_FILE)
    const broken = compositionProblem(compositionPath)
    found.push({
      id: child.name,
      trust: root.trust,
      dir,
      compositionPath,
      editable: root.writable,
      ...readPresetMetadata(dir),
      ...broken === undefined ? {} : { broken },
    })
  }
  // Declared priority first, so a shipped set reads in capability order; the id
  // is the tiebreak, which keeps authored presets stable. Two presets that
  // declare no priority compare by id rather than by directory order (the
  // host's subtraction yields NaN there, which `sort` silently treats as equal).
  return found.sort((left, right) => {
    const byOrder = (left.order ?? Number.POSITIVE_INFINITY) - (right.order ?? Number.POSITIVE_INFINITY)
    return byOrder === 0 || Number.isNaN(byOrder) ? left.id.localeCompare(right.id) : byOrder
  })
}

/**
 * Every preset the roots supply, first-root-wins per id.
 * @param roots - roots in precedence order; an earlier root wins a duplicate id.
 * @returns the roster, each root's own order preserved.
 */
export function discoverPresets(roots: readonly PresetRootInfo[]): PresetRow[] {
  const byId = new Map<string, PresetRow>()
  for (const root of roots) {
    for (const preset of scanRoot(root)) {
      if (byId.has(preset.id)) continue
      byId.set(preset.id, preset)
    }
  }
  return [...byId.values()]
}

/**
 * Find one roster row by id.
 * @param presets - the discovered roster.
 * @param id - the preset id.
 * @returns the row, or undefined when no root supplies that id.
 */
export function presetById(presets: readonly PresetRow[], id: string): PresetRow | undefined {
  return presets.find(preset => preset.id === id)
}
