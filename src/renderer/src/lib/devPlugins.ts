/**
 * The dev-plugin page's decision logic, kept out of the view so it can be tested:
 * which compare target is remembered, how a resolved reference reads, and what the
 * build menu offers.
 *
 * No React and no antd here — the menu items and the status/tag results come back as
 * plain descriptors, and the view maps them onto components. That is what keeps
 * this module inside the vitest include.
 */
import { fmtDateTime } from './format.ts'
import type { DevBuildScope, DevDiagnosis, DevDiagnosisMeta, DevResolveRoot, DevResolveState } from '../../../shared/types.ts'

// ── the remembered compare target ───────────────────────────────────────────

/** Where the chosen compare chain is remembered (a renderer-local view preference,
 * like the plugin overview's filters). */
export const TARGET_KEY = 'pm.dev.target'

/** The compare TARGET: which dsh, and optionally which of its profiles. It is what
 * the list's badges were computed against and what a new dialog starts from. A stale
 * dsh falls back to the first registered one, a stale profile to "none". */
export interface DevTarget {
  dshId?: string
  profile?: string
}

/** Read the remembered target, dropping anything that is not a non-empty string —
 * the stored value is only ever written by this module, but a hand-edited or
 * half-written entry must not become a target. */
export function readSavedTarget(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): DevTarget {
  try {
    const raw = storage?.getItem(TARGET_KEY) ?? null
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as { dshId?: unknown; profile?: unknown } | null
    if (parsed === null || typeof parsed !== 'object') return {}
    return {
      ...(typeof parsed.dshId === 'string' && parsed.dshId !== '' ? { dshId: parsed.dshId } : {}),
      ...(typeof parsed.profile === 'string' && parsed.profile !== '' ? { profile: parsed.profile } : {}),
    }
  } catch {
    return {}
  }
}

/** Remember the target. Storage can be unavailable (a locked-down renderer), which
 * is not an error worth surfacing — the target just is not remembered. */
export function saveTarget(target: DevTarget, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(TARGET_KEY, JSON.stringify(target)) } catch { /* storage unavailable */ }
}

/** Whether two targets mean the same chain (an absent profile = host layers only). */
export function sameTarget(a: DevTarget, b: DevTarget): boolean {
  return (a.dshId ?? '') === (b.dshId ?? '') && (a.profile ?? '') === (b.profile ?? '')
}

/** `dsh@1.2.0` when the name already carries the version, else `name (version)`. */
export function hostLabel(host: { name: string; version?: string } | undefined, fallback?: string): string {
  if (host === undefined) return fallback ?? '—'
  return host.version !== undefined && host.version !== '' && !host.name.includes(host.version)
    ? `${host.name} (${host.version})`
    : host.name
}

// ── what a diagnosis amounts to ─────────────────────────────────────────────

/** The verdict a package's badge shows, as a descriptor the view maps onto a colour
 * and a label. `issues` counts both kinds of problem the badge summarizes. */
type StatusDescriptor =
  | { kind: 'noEntry' }
  | { kind: 'issues'; count: number }
  | { kind: 'ok' }

/** `null` when this package has no report yet (nothing was diagnosed for it). */
export function statusOf(diagnosis: DevDiagnosis | undefined): StatusDescriptor | null {
  if (diagnosis === undefined) return null
  if (diagnosis.entryMissing === true) return { kind: 'noEntry' }
  const issues = diagnosis.missingPatchRows.length + diagnosis.missingPeers.length
  return issues > 0 ? { kind: 'issues', count: issues } : { kind: 'ok' }
}

/** How one resolved reference reads.
 *
 * "Missing" (nothing has it) and "dangling" (the directory entry is there but its
 * link target is gone) are DIFFERENT problems with different fixes — install the
 * package versus repair the link — so they never collapse into one verdict. */
type ResolveDescriptor =
  | { kind: 'missing' }
  | { kind: 'dangling'; target: string }
  | { kind: 'resolved'; root: DevResolveRoot; peer: boolean }

export function resolveDescriptor(
  hit: { dir?: string; root?: DevResolveRoot; state?: DevResolveState; link?: string },
  peer = false,
): ResolveDescriptor {
  if (hit.dir === undefined || hit.state === undefined) return { kind: 'missing' }
  if (hit.state === 'dangling') return { kind: 'dangling', target: hit.link ?? hit.dir }
  return { kind: 'resolved', root: hit.root ?? 'monorepo', peer }
}

// ── what a report was computed against ──────────────────────────────────────

/** The chain a verdict belongs to, as an i18n key plus its params. A verdict is
 * not readable without the chain it was computed for, so the two travel together
 * everywhere one is shown. */
interface ScopeLabel {
  key: 'plugin.dev.detectedAt' | 'plugin.dev.detectedAtHost'
  params: { time: string; host: string; profile?: string }
}

/** Which key names the chain, and the host name to put in it.
 *
 * The host is named as it was AT DIAGNOSIS TIME and falls back to the recorded
 * name — the dsh may since have been uninstalled, and a report that cannot say
 * what it was computed against is worse than one naming a host that is gone. */
export function scopeLabel(
  meta: DevDiagnosisMeta | undefined,
  hosts: readonly { id: string; name: string; version?: string }[],
): ScopeLabel | null {
  if (meta === undefined) return null
  const host = hostLabel(hosts.find(h => h.id === meta.dshId), meta.dshName)
  const time = fmtDateTime(meta.at)
  return meta.profile !== undefined && meta.profile !== ''
    ? { key: 'plugin.dev.detectedAt', params: { time, host, profile: meta.profile } }
    : { key: 'plugin.dev.detectedAtHost', params: { time, host } }
}

// ── the build menu ──────────────────────────────────────────────────────────

/** One build-menu entry: a labelled group of script keys. Deliberately NOT antd's
 * `MenuProps['items']` — the two shapes are compatible, and staying off the type
 * keeps this module testable without a DOM. */
interface BuildMenuItem {
  type: 'group'
  label: string
  children: { key: string; label: string }[]
}

/** The package's own scripts and its workspace root's, grouped — and a group with no
 * scripts is left out entirely rather than shown empty. */
export function buildMenuItems(
  options: { package: readonly string[]; workspace: readonly string[] } | undefined,
  labels: { package: string; workspace: string },
): BuildMenuItem[] {
  if (options === undefined) return []
  const group = (label: string, scope: DevBuildScope, scripts: readonly string[]): BuildMenuItem | null =>
    scripts.length === 0 ? null : { type: 'group', label, children: scripts.map(s => ({ key: `${scope}:${s}`, label: s })) }
  return [
    group(labels.package, 'package', options.package),
    group(labels.workspace, 'workspace', options.workspace),
  ].filter((g): g is BuildMenuItem => g !== null)
}

/** Read a build-menu key back into its target. A key with no `scope:` prefix reads
 * as the package scope, which is what the menu's own keys always carry. */
export function parseBuildKey(key: string): { script: string; scope: DevBuildScope } {
  const at = key.indexOf(':')
  return { script: key.slice(at + 1), scope: key.slice(0, at) === 'workspace' ? 'workspace' : 'package' }
}
