/**
 * Pure helpers for the multi-run registry — the scheduling/labelling decisions
 * behind `ipc/run.ts`, kept free of Electron and `ChildProcess` so they are
 * unit-testable. The process map itself lives in the IPC layer; only the
 * decisions that can be reasoned about in isolation live here.
 */

/** A run's identity: a profile name is unique per dsh, so the dsh id is part of
 * the single-instance key. */
interface HasRun {
  dshId: string
  profile: string
}

/**
 * Build a stable, sortable run id from the profile and a monotonically
 * increasing sequence number. A sequence (not a timestamp) keeps ids
 * deterministic in tests and collision-free when two runs start in the same ms.
 */
export function nextRunId(profile: string, seq: number): string {
  return `${profile}#${seq}`
}

/**
 * True when this exact (dsh, profile) pair already has a live run — the
 * single-instance guard. The same profile name under a different dsh, and
 * different profiles under one dsh, may all run concurrently.
 */
export function hasRun(runs: readonly HasRun[], dshId: string, profile: string): boolean {
  return runs.some(run => run.dshId === dshId && run.profile === profile)
}

/** Human-readable run duration from an elapsed-millisecond count, e.g.
 * `3 分 12 秒` (Chinese UI copy; keeps its units in the caller's locale). */
export function formatRunDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h} 时 ${m} 分 ${s} 秒`
  if (m > 0) return `${m} 分 ${s} 秒`
  return `${s} 秒`
}
