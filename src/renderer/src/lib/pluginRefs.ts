/**
 * Which profile references no longer resolve — aggregated for the plugins page.
 *
 * Deliberately derived from the overview the page already has, rather than from a
 * second scan: a second scanner would be a second answer to "is this reference
 * broken", and the day the two disagree the page would show a state that does not
 * exist. One source, one verdict.
 */
import type { InstalledOverviewRow, PluginUsagePoint } from '../../../shared/types.ts'

/** One profile holding a reference that cannot be resolved. */
export interface BrokenRef {
  name: string
  dsh: string
  profile: string
  /** The raw spec, when the profile declares one — what the fix has to act on. */
  spec?: string
}

/** Every broken reference across the overview, sorted by plugin then profile. */
export function brokenRefs(rows: readonly InstalledOverviewRow[]): BrokenRef[] {
  const out: BrokenRef[] = []
  for (const row of rows) {
    for (const u of row.usage) {
      if (u.broken !== true) continue
      out.push({ name: row.name, dsh: u.dsh, profile: u.profile, ...(u.spec !== undefined ? { spec: u.spec } : {}) })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.profile.localeCompare(b.profile))
}

/** The plugins that own at least one broken reference, for "show me this one". */
export function brokenPluginNames(refs: readonly BrokenRef[]): string[] {
  return [...new Set(refs.map(r => r.name))]
}

/** One line per plugin, listing its affected profiles — the banner's body. */
export function describeBroken(refs: readonly BrokenRef[]): { name: string; profiles: string }[] {
  const by = new Map<string, string[]>()
  for (const r of refs) {
    const list = by.get(r.name)
    if (list === undefined) by.set(r.name, [r.profile])
    else list.push(r.profile)
  }
  return [...by].map(([name, profiles]) => ({ name, profiles: profiles.join(' · ') }))
}

/** Whether a usage point should offer the destructive "clean up" label rather than
 * the neutral "detach". Pure, so the wording decision is testable. */
export function isBrokenUsage(u: Pick<PluginUsagePoint, 'broken'>): boolean {
  return u.broken === true
}
