/**
 * How well one preset fits one profile.
 *
 * A preset's rows name modules, and whether those modules exist depends on
 * WHERE the session runs: the installed harness carries most of them, but a
 * profile that links its own plugins — a store install, or a bundle that is only
 * a dependency of that profile — resolves a different set. The host's own health
 * check cannot answer this question: it walks the install chain alone, from a
 * base inside the harness, because it judges a roster rather than a launch. This
 * module answers the per-profile question instead, over the same resolution
 * chain the launcher already uses for a profile's layer rows: the install's own
 * Node lookup chain, then the profile's `node_modules`, then the shared profiles
 * root, then the home.
 *
 * The verdict is deliberately three-valued. A composition that cannot be read at
 * all is unusable; a readable one keeps its rows and reports the ones no
 * resolver finds, because "this preset mostly works here" is a different answer
 * from "this preset cannot mount here", and only the second one is hopeless.
 */

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveModule } from '../store/module-resolve.ts'
import { readComposition, type CompositionRead, type CompositionRow } from './rows.ts'
import type { DshContext } from '../profile/appState.ts'
import type { PresetGrade, PresetMissingRow, PresetRow } from '../../../shared/types.ts'

/** Whether `path` names an existing regular file (any stat failure is a no). */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    // Absent, unreadable, or a dangling link all mean the same thing here: this
    // row names no file the loader could import.
    return false
  }
}

/** This profile's answer for one package name, cached for the whole read: a
 * preset repeats the same handful of packages, and one resolution walks the
 * install anchor and compiles a Node lookup chain. */
type PackageCache = Map<string, boolean>

/** Whether one row's module resolves for this profile. */
function rowResolves(
  ctx: DshContext,
  profile: string,
  presetDir: string,
  row: CompositionRow,
  cache: PackageCache,
): boolean {
  if (row.kind === 'builtin') return true
  if (row.kind === 'preset') return isFile(resolve(presetDir, row.name))
  if (row.kind === 'file') {
    try {
      // A `file:` URL is what the host hands a resolver; an absolute path is the
      // same thing spelled the way a person writes it. Deliberately resolved
      // WITHOUT a base, which is what the host does: a `file:` specifier is an
      // absolute URL there too, so `file:./x.mjs` beside the declaring file never
      // reaches it (the host refuses the row on Windows and lands on the drive
      // root on POSIX — measured, see rows.ts). Supplying a base here would call
      // a row the host rejects usable. A preset that means "the file next to me"
      // writes `./x.mjs`, which is the `preset` row kind and IS based.
      return isFile(row.name.startsWith('file:') ? fileURLToPath(new URL(row.name)) : row.name)
    } catch {
      // A malformed URL names no file either.
      return false
    }
  }
  const cached = cache.get(row.name)
  if (cached !== undefined) return cached
  const found = resolveModule(ctx, row.name, { profile })
  const ok = found !== undefined && found.state === 'ok'
  cache.set(row.name, ok)
  return ok
}

/** One preset to judge, however it was defined. */
export interface GradeTarget {
  id: string
  /** Base a `.`-relative row resolves against: a preset's own directory, or the
   * directory of the patch file that declared it. */
  baseDir: string
  /** The rows, or why they cannot be read. */
  read: CompositionRead
}

/** The grade targets a DIRECTORY-model roster yields: each row's composition is
 * read from its own file, reusing discovery's verdict when it already failed —
 * a second read of a broken file would only race the same answer. */
export function directoryGradeTargets(presets: readonly PresetRow[]): GradeTarget[] {
  return presets.map(preset => {
    if (preset.broken !== undefined) {
      return { id: preset.id, baseDir: preset.dir, read: { ok: false, problem: preset.broken } }
    }
    try {
      const read = readComposition(readFileSync(preset.compositionPath, 'utf8'))
      return { id: preset.id, baseDir: preset.dir, read }
    } catch {
      // Discovery statted this file moments ago; any read failure now is the same
      // answer as an unloadable one.
      return { id: preset.id, baseDir: preset.dir, read: { ok: false, problem: 'the composition file cannot be read' } }
    }
  })
}

/** One preset's grade under one profile, from its already-read composition. */
function gradeOne(
  ctx: DshContext,
  target: GradeTarget,
  profile: string,
  cache: PackageCache,
): PresetGrade {
  const identity = { presetId: target.id, profile }
  const read = target.read
  if (!read.ok) {
    return {
      ...identity, level: 'unusable', checked: 0, skipped: 0, conditional: 0, missing: [], reason: read.problem,
    }
  }
  const enabled = read.rows.filter(row => !row.skipped)
  const missing: PresetMissingRow[] = []
  let conditional = 0
  for (const row of enabled) {
    // A `!!js` specifier is the loader's to decide; reporting it as missing
    // would call a preset the loader accepts broken, which is the failure the
    // host's own check goes out of its way to avoid.
    if (row.conditional) {
      conditional += 1
      continue
    }
    if (rowResolves(ctx, profile, target.baseDir, row, cache)) continue
    missing.push({ label: row.label, name: row.name })
  }
  return {
    ...identity,
    level: missing.length === 0 ? 'ok' : 'incomplete',
    checked: enabled.length - conditional,
    skipped: read.rows.length - enabled.length,
    conditional,
    missing,
  }
}

/**
 * Grade every target against every profile of one dsh.
 * @param ctx - the dsh whose install chain and profiles are used.
 * @param targets - the presets to judge, from either preset model.
 * @param profiles - the profile names to grade against.
 * @returns one cell per target and profile, in target order.
 */
export function gradeTargets(
  ctx: DshContext,
  targets: readonly GradeTarget[],
  profiles: readonly string[],
): PresetGrade[] {
  // One cache per profile, shared by every preset: the same packages recur, and
  // a profile's resolution chain is the expensive part of a probe.
  const caches = new Map<string, PackageCache>()
  const cells: PresetGrade[] = []
  for (const target of targets) {
    for (const profile of profiles) {
      let cache = caches.get(profile)
      if (cache === undefined) {
        cache = new Map<string, boolean>()
        caches.set(profile, cache)
      }
      cells.push(gradeOne(ctx, target, profile, cache))
    }
  }
  return cells
}

/**
 * Grade every preset of a DIRECTORY-model roster against every profile of one dsh.
 * @param ctx - the dsh whose install chain and profiles are used.
 * @param presets - the discovered roster.
 * @param profiles - the profile names to grade against.
 * @returns one cell per preset and profile, in roster order.
 */
export function gradePresets(
  ctx: DshContext,
  presets: readonly PresetRow[],
  profiles: readonly string[],
): PresetGrade[] {
  return gradeTargets(ctx, directoryGradeTargets(presets), profiles)
}
