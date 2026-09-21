/** Editing a profile's manifest: its display name and patch lifecycle, its dependencies, and which bundles are activated as layers. */


import {
  addBundle, removeBundle, removeDependency, reorderBundle, setDependency, setManifestMeta, writeProfileFile,
} from '../../core/profile/profile.ts'
import { fail, E } from '../../core/shared/errors.ts'
import { ctxOf } from '../ctxOf.ts'
import { handle } from '../handle.ts'
import { invalidName } from './helpers.ts'
import type { IpcResult, ProfileFileKind, ProfilePatchReload } from '../../../shared/types.ts'



/** Validate a config value is a YAML mapping. Structure only, so a cordis
 * `!!js` reference (which the schema cannot resolve) is not misread as bad
 * YAML. Throws with a friendly message. */

export function registerProfileEditIpc(): void {
  handle('profile:writeFile', (_event, dshId: string, name: string, kind: ProfileFileKind, text: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    if (kind !== 'manifest' && kind !== 'patch') return fail(E.nameInvalid)
    writeProfileFile(ctx, name, kind, text)
    return { ok: true, value: true }
  })

  handle('profile:setManifest', (_event, dshId: string, name: string, meta: { displayName?: string; patchReload?: ProfilePatchReload }): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    setManifestMeta(ctx, name, meta)
    return { ok: true, value: true }
  })

  // ── structured manifest edits ───────────────────────────────────────────
  handle('profile:setDependency', async (_event, dshId: string, name: string, pkg: string, spec: string): Promise<IpcResult<boolean>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    await setDependency(ctx, name, pkg, spec)
    return { ok: true, value: true }
  })

  handle('profile:removeDependency', async (_event, dshId: string, name: string, pkg: string): Promise<IpcResult<boolean>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    await removeDependency(ctx, name, pkg)
    return { ok: true, value: true }
  })

  // Activate an installed package as a bundle layer.
  handle('profile:addBundle', (_event, dshId: string, name: string, pkg: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name) || invalidName(pkg)) return fail(E.nameInvalid)
    addBundle(ctx, name, pkg)
    return { ok: true, value: true }
  })

  handle('profile:removeBundle', async (_event, dshId: string, name: string, bundle: string): Promise<IpcResult<boolean>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name) || invalidName(bundle)) return fail(E.nameInvalid)
    await removeBundle(ctx, name, bundle)
    return { ok: true, value: true }
  })

  // Move one bundle layer to `toIndex` within `dsh.profile.bundles`.
  handle('profile:reorderBundle', (_event, dshId: string, name: string, bundle: string, toIndex: number): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name) || invalidName(bundle)) return fail(E.nameInvalid)
    if (!Number.isInteger(toIndex)) return fail(E.nameInvalid, [], 'toIndex 必须是整数')
    reorderBundle(ctx, name, bundle, toIndex)
    return { ok: true, value: true }
  })
}
