/**
 * Which identity a profile is bound to for one package name.
 *
 * A package can exist twice on this machine — once as a dev plugin (a source
 * directory, linked into profiles as `link:<dir>`) and once as an archived
 * version in the store (installed into a profile as `file:<archive dir>`). Both
 * are legitimate at the same time; what a profile has is exactly one of them,
 * because Node resolves a package name to one directory.
 *
 * The binding is DERIVED from the profile's dependency spec rather than stored.
 * A stored copy would be a second source of truth: the manifest can be edited by
 * hand, by dsh, or by an older launcher, and the record would then claim an
 * origin the profile does not have. Deriving cannot disagree with reality.
 *
 * Pure — no filesystem, no settings. The caller passes the registered dev dirs.
 */
import { resolve } from 'node:path'

/** Where one profile's dependency on a package points. */
export type ProfileBinding =
  /** A registered dev plugin's source directory. */
  | 'dev'
  /** An archived version in the store (a `file:` into the archive, or a version
   * spec that pnpm resolved from it). */
  | 'store'
  /** A `link:`/`file:` that points somewhere else entirely — neither a registered
   * dev plugin nor the store. Reported honestly rather than guessed at. */
  | 'external'
  /** The profile does not depend on this package at all. */
  | 'missing'

/** The binding across several profiles. */
export type Binding = ProfileBinding | 'mixed'

/** Normalize a path for comparison: absolute, no trailing separator, and
 * case-insensitive on Windows — the same directory must not look like two. */
function canonical(path: string): string {
  const absolute = resolve(path)
  const trimmed = absolute.length > 1 ? absolute.replace(/[\\/]+$/, '') : absolute
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/** The directory a `link:`/`file:` spec points at, or `undefined` for any other
 * spec (a version range is resolved by pnpm, not by us). */
export function specTarget(spec: string | undefined): string | undefined {
  if (typeof spec !== 'string') return undefined
  if (spec.startsWith('link:')) return spec.slice('link:'.length)
  if (spec.startsWith('file:')) return spec.slice('file:'.length)
  return undefined
}

/**
 * Where one profile's dependency points.
 *
 * `devDirs` holds the registered dev plugin directories (already resolved). A
 * `link:` to anything else is `external`, not `dev`: a hand-made link to a build
 * output is a real situation, and calling it a dev plugin would make the UI claim
 * something the launcher cannot manage.
 */
export function bindingOf(spec: string | undefined, devDirs: ReadonlySet<string>): ProfileBinding {
  if (typeof spec !== 'string' || spec.trim() === '') return 'missing'
  const target = specTarget(spec.trim())
  if (target === undefined) {
    // A version range: pnpm resolved it from the store, which is the only place
    // this launcher installs from.
    return 'store'
  }
  if (target === '') return 'external'
  if (spec.trim().startsWith('link:')) {
    // A link is only "dev" when it is a registered dev plugin's own directory.
    return devDirs.has(canonical(target)) ? 'dev' : 'external'
  }
  // `file:` — the launcher writes it for an archived version in the store.
  return 'store'
}

/**
 * The binding across every profile that depends on the package.
 *
 * Disagreement is reported as `mixed` rather than collapsed to one side: "p1 runs
 * my working copy, p2 runs the published build" is exactly the state a person
 * needs to see, and picking either answer would hide it.
 */
export function aggregateBinding(bindings: readonly ProfileBinding[]): Binding {
  const present = bindings.filter(binding => binding !== 'missing')
  if (present.length === 0) return 'missing'
  const first = present[0]
  return present.every(binding => binding === first) ? first : 'mixed'
}

/** The canonical form of a directory, for building the `devDirs` set. */
export function devDirKey(dir: string): string {
  return canonical(dir)
}
