/** A profile instance's life: create, clone, rename, soft-delete, and moving its patch layer to another profile. */


import { reconcileBundles } from '../../core/store/combo.ts'
import {
  cloneProfile, createProfile, PROFILE_TEMPLATES, renameProfile, softDeleteProfile, transferProfilePatch,
} from '../../core/profile/profile.ts'
import { fail, E } from '../../core/shared/errors.ts'
import { ctxOf } from '../ctxOf.ts'
import { handle } from '../handle.ts'
import { invalidName } from './helpers.ts'
import { isProfileRunning } from '../dsh/run.ts'
import type { IpcResult } from '../../../shared/types.ts'



/** Validate a config value is a YAML mapping. Structure only, so a cordis
 * `!!js` reference (which the schema cannot resolve) is not misread as bad
 * YAML. Throws with a friendly message. */

export function registerProfileLifecycleIpc(): void {
  handle('profile:create', (_event, dshId: string, name: string, template?: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    // `template`: official keys prefixed `template:` (base/web), or an existing
    // profile name to clone. Empty → default base.
    const OFFICIAL_PREFIX = 'template:'
    if (template !== undefined && template.startsWith(OFFICIAL_PREFIX)) {
      const key = template.slice(OFFICIAL_PREFIX.length)
      if (!(key in PROFILE_TEMPLATES)) throw new Error(`unknown template "${key}"`)
      createProfile(ctx, name, PROFILE_TEMPLATES[key])
    } else if (template !== undefined && template !== '') {
      if (invalidName(template)) return fail(E.nameInvalid)
      cloneProfile(ctx, template, name)
    } else {
      createProfile(ctx, name)
    }
    return { ok: true, value: true }
  })

  handle('profile:clone', (_event, dshId: string, name: string, newName: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name) || invalidName(newName)) return fail(E.nameInvalid)
    cloneProfile(ctx, name, newName)
    return { ok: true, value: true }
  })

  handle('profile:delete', (_event, dshId: string, name: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    // A rename is refused while live; a delete must be too — moving the dir out
    // from under a running dsh (whose cwd is inside it) leaves a half state.
    if (isProfileRunning(dshId, name)) return fail(E.runAlreadyRunning, { profile: name })
    softDeleteProfile(ctx, name)
    return { ok: true, value: true }
  })

  // Rename a profile's directory (refused while its runtime is live).
  handle('profile:rename', (_event, dshId: string, oldName: string, newName: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(oldName) || invalidName(newName)) return fail(E.nameInvalid)
    if (isProfileRunning(dshId, oldName)) return fail(E.runAlreadyRunning, { profile: oldName })
    renameProfile(ctx, oldName, newName)
    return { ok: true, value: true }
  })

  // Copy (or move) a profile's patch layer into another profile, merging by id.
  handle('profile:transferPatch', (_event, sourceDshId: string, sourceName: string, targetDshId: string, targetName: string, move: boolean): IpcResult<boolean> => {
    const source = ctxOf(sourceDshId)
    const target = ctxOf(targetDshId)
    if (source === null || target === null) return fail(E.dshNotFound)
    if (invalidName(sourceName) || invalidName(targetName)) return fail(E.nameInvalid)
    transferProfilePatch(source, sourceName, target, targetName, move === true)
    return { ok: true, value: true }
  })

  // Manually re-reconcile the bundles layer against installed state.
  handle('profile:reconcile', (_event, dshId: string, name: string): IpcResult<{ added: string[]; removed: string[] }> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    return { ok: true, value: reconcileBundles(ctx, name) }
  })
}
