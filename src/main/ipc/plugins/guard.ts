/**
 * The "a live dsh process is using this profile" gate shared by every plugin
 * write.
 *
 * Writing a profile's files while its process runs is not a safe operation: the
 * process holds the installed package bodies open (deleting a native module
 * fails with EPERM), and its HMR watcher only reloads what it is told to. The
 * update path and the dev-link path already refuse in that situation; these
 * helpers give the store paths the same answer, in the shape the renderer
 * already knows how to ask about (`needsConfirm`), so a refusal stays a question
 * rather than a dead end.
 *
 * A refusal means NOTHING was written. That is the whole contract: the check
 * runs before the first byte of a manifest changes.
 */
import { isProfileRunning } from '../dsh/run.ts'
import type { PluginUsagePoint, PluginWriteConsent, RunningProfileRef } from '../../../shared/types.ts'

/** The usage points whose profile currently has a live dsh process. */
export function runningAmong(usages: readonly PluginUsagePoint[]): RunningProfileRef[] {
  return usages
    .filter(usage => isProfileRunning(usage.dshId, usage.profile))
    .map(usage => ({ dsh: usage.dsh, dshId: usage.dshId, profile: usage.profile }))
}

/**
 * The confirmation a write has to obtain first.
 * @param usages - the usage points the write would touch.
 * @param consent - what the caller already accepted; `acknowledgeRunning` ends
 *   the offer and lets the write proceed.
 * @returns a `profiles-running` refusal, or `undefined` to proceed.
 */
export function runningRefusal(
  usages: readonly PluginUsagePoint[], consent?: PluginWriteConsent,
): { needsConfirm: 'profiles-running'; profiles: RunningProfileRef[] } | undefined {
  if (consent?.acknowledgeRunning === true) return undefined
  const profiles = runningAmong(usages)
  return profiles.length === 0 ? undefined : { needsConfirm: 'profiles-running', profiles }
}

/** A single-profile refusal, for writes addressed to one known target. */
export function oneRunningRefusal(
  dsh: string, dshId: string, profile: string, consent?: PluginWriteConsent,
): { needsConfirm: 'profiles-running'; profiles: RunningProfileRef[] } | undefined {
  return runningRefusal([{ dsh, dshId, profile }], consent)
}
