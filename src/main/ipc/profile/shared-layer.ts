/**
 * Writes to the MACHINE-LEVEL patch layer: `<home>/cordis.patch.yml`.
 *
 * That file is not one profile's business. dsh composes it into every profile
 * under the home, and every running process watches it — its HMR watcher reloads
 * on an ordinary write and has no bundle-list gate for it (unlike a profile
 * manifest, where a dependency-only edit is ignored). So one save recomposes a
 * profile the person was not looking at.
 *
 * That is a supported feature, not a defect: the layer exists to be shared. What
 * this module adds is the disclosure the UI owed — the profiles a write will
 * move, named, before it moves them.
 */
import { isProfileRunning } from '../dsh/run.ts'
import { dshEntryById, type DshContext } from '../../core/profile/appState.ts'
import { listProfiles } from '../../core/profile/home.ts'
import type { PluginWriteConsent, RunningProfileRef } from '../../../shared/types.ts'

/** Profiles under this context's home that currently have a live dsh process. */
export function runningProfilesFor(ctx: DshContext): RunningProfileRef[] {
  // The dsh NAME is what the confirmation shows; the id is what addresses a run.
  const dsh = dshEntryById(ctx.id)?.name ?? ctx.id
  return listProfiles(ctx)
    .filter(profile => isProfileRunning(ctx.id, profile))
    .map(profile => ({ dsh, dshId: ctx.id, profile }))
}

/**
 * The confirmation a shared-layer write has to obtain first.
 * @param ctx - the dsh whose home the write targets.
 * @param consent - what the caller already accepted.
 * @returns a `profiles-running` refusal naming the live profiles, or `undefined`
 *   when the write may proceed (no live process, or the caller consented).
 */
export function sharedLayerRefusal(
  ctx: DshContext, consent?: PluginWriteConsent,
): { needsConfirm: 'profiles-running'; profiles: RunningProfileRef[] } | undefined {
  if (consent?.acknowledgeRunning === true) return undefined
  const profiles = runningProfilesFor(ctx)
  return profiles.length === 0 ? undefined : { needsConfirm: 'profiles-running', profiles }
}
