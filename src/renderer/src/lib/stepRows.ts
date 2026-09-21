/**
 * The step rows an import/mirror stream renders: one row per bundle, plus the final
 * install wait step.
 *
 * Shared because the two flows that stream these steps (import a profile, mirror a
 * dsh) differ only in how a bundle row is LABELLED — one prefixes the resolved
 * source. The row shape and its update rule are the same, and `upsertRow` is pure so
 * the rule is testable without a renderer.
 */
import type { ImportStep } from '../../../shared/types.ts'

/** One streamed step, as the dialog shows it. */
export interface StepRow {
  /** Stable identity: `bundle:<name>`, or `install`. */
  key: string
  section: 'bundle' | 'install'
  label: string
  status: 'running' | 'ok' | 'error'
  /** Right-aligned version detail (the store version once installed). */
  meta?: string
  detail?: string
}

/**
 * Replace the row with this key, or append it.
 *
 * Steps for the SAME bundle arrive repeatedly (running → ok/error), and a burst can
 * land in one tick, so callers must feed this their latest list rather than a state
 * value that has not re-rendered yet. Order is first-seen, so a bundle keeps its
 * place as its status changes.
 */
export function upsertRow(rows: readonly StepRow[], row: StepRow): StepRow[] {
  const next = [...rows]
  const at = next.findIndex(r => r.key === row.key)
  if (at >= 0) next[at] = row
  else next.push(row)
  return next
}

/** The row a bundle step produces. Steps with no version leave `meta` off. */
export function bundleStepRow(step: Extract<ImportStep, { kind: 'bundle' }>, label: string): StepRow {
  return {
    key: `bundle:${step.name}`,
    section: 'bundle',
    label,
    status: step.state,
    ...(step.version !== undefined && step.version !== '' ? { meta: `v${step.version}` } : {}),
    ...(step.detail !== undefined ? { detail: step.detail } : {}),
  }
}
