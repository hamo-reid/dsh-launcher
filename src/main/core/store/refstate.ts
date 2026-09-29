/**
 * What a profile's reference to one package actually amounts to.
 *
 * A profile can be in three states with respect to a plugin, and the third is
 * the one that used to be invisible:
 *
 *   none     nothing declared, nothing installed — the plugin is simply unused
 *   ok       something is installed and reads back
 *   BROKEN   something is DECLARED and points at nothing: a `link:` whose source
 *            dir is gone, or a `file:` into an archived version that was deleted
 *
 * The broken state is reached by ordinary use — deleting an archived version
 * does not touch the profiles that depend on it — and it is indistinguishable
 * from "fine" if the check is `existsSync(node_modules/<pkg>)`, because a
 * dangling junction reads as absent in both the ok and the broken case. So it is
 * computed from the DECLARED spec, not from what happens to be on disk.
 *
 * One predicate, two consumers: the overview decides what to show as broken, and
 * the uninstall path decides whether deleting a version is safe. They must agree
 * or the UI would offer a fix the backend then refuses.
 */
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** The reference a profile declares, read against what is actually there. */
export interface RefFacts {
  /** The raw dependency spec, when the profile declares one. */
  spec?: string
  /** The directory a `link:`/`file:` spec points at. */
  target?: string
  /** A readable `package.json` is installed in the profile's node_modules. */
  installed: boolean
  /** The profile entry exists but cannot be read through — a dangling link. */
  danglingEntry: boolean
  /** Declared-or-installed, but unreadable: the state that must be surfaced. */
  broken: boolean
}

/** The target of a `link:`/`file:` spec, or `undefined` for any other spec. */
function specTarget(spec: string | undefined): string | undefined {
  if (typeof spec !== 'string') return undefined
  if (spec.startsWith('link:')) return spec.slice('link:'.length)
  if (spec.startsWith('file:')) return spec.slice('file:'.length)
  return undefined
}

/** Whether the profile's own `node_modules` entry is a link whose target is gone.
 * `existsSync` cannot see this — it follows the link and reports absent — but a
 * leftover junction still pins whatever it points at, so it has to be told apart
 * from a package that was never installed. */
function isDanglingEntry(pkgDir: string): boolean {
  let st
  try {
    st = lstatSync(pkgDir)
  } catch {
    return false // no entry at all — that is "not installed", not "broken"
  }
  if (!st.isSymbolicLink()) return false
  try {
    statSync(pkgDir)
    return false
  } catch {
    return true
  }
}

/** Read one (profile, package) reference. Pure filesystem, no settings. */
export function readRef(pkg: string, profileDir: string, spec: string | undefined): RefFacts {
  const target = specTarget(spec)
  const targetMissing = target !== undefined && !existsSync(join(target, 'package.json'))
  const danglingEntry = isDanglingEntry(join(profileDir, 'node_modules', pkg))
  const installed = existsSync(join(profileDir, 'node_modules', pkg, 'package.json'))
  return {
    ...(spec !== undefined ? { spec } : {}),
    ...(target !== undefined ? { target: resolve(target) } : {}),
    installed,
    danglingEntry,
    // A broken reference is a DECLARED one that resolves to nothing, or an
    // entry that is there but unreadable. A profile that simply never installed
    // anything is not broken: nothing declared, nothing dangling.
    broken: targetMissing || danglingEntry,
  }
}

/** Read a manifest's dependencies, tolerating an absent or unreadable file. */
export function readDeps(manifestPath: string): Record<string, string> {
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
    return m.dependencies ?? {}
  } catch {
    return {}
  }
}
