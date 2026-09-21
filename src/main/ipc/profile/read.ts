/** Reading a profile: its summary, its composed detail, its layers, its resolved patch rows, and the raw file the source editor shows. */


import { shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { listProfiles, profilePatchPath } from '../../core/profile/home.ts'
import { extractKeyValue } from '../../core/patch/patch.ts'
import {
  composeProfileLayers, defaultConfigText, findInsertConflicts, listUnclaimedBundles, validateComposition,
} from '../../core/store/combo.ts'
import {
  listLocalBundles, listProfileSummaries, profileDirPath, readProfileFile, type ProfileSummary,
} from '../../core/profile/profile.ts'
import { pluginDir } from '../../core/profile/appState.ts'
import { fail, E } from '../../core/shared/errors.ts'
import { ctxOf } from '../ctxOf.ts'
import { handle } from '../handle.ts'
import { invalidName, loadProfileDetail } from './helpers.ts'
import { isProfileRunning } from '../dsh/run.ts'
import type {
  InsertConflict, IpcResult, ProfileDetail, ProfileFileKind, ProfileLayer, ProfileValidation,
} from '../../../shared/types.ts'



/** Validate a config value is a YAML mapping. Structure only, so a cordis
 * `!!js` reference (which the schema cannot resolve) is not misread as bad
 * YAML. Throws with a friendly message. */

export function registerProfileReadIpc(): void {
  handle('profile:list', (_event, dshId: string): IpcResult<string[]> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    return { ok: true, value: listProfiles(ctx) }
  })

  handle('profile:load', (_event, dshId: string, name: string): IpcResult<ProfileDetail> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    return { ok: true, value: loadProfileDetail(ctx, name) }
  })

  // ── profile instances ────────────────────────────────────────────────
  handle('profile:summaries', (_event, dshId: string): IpcResult<ProfileSummary[]> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    // Flag live profiles so the list can show "running" and refuse a delete.
    return { ok: true, value: listProfileSummaries(ctx).map(s => ({ ...s, running: isProfileRunning(dshId, s.name) })) }
  })

  handle('profile:missingBundles', (_event, dshId: string, name: string): IpcResult<string[]> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    return { ok: true, value: listUnclaimedBundles(ctx, name) }
  })

  // The composition stack: bundle layers in order, then profile, then home.
  handle('profile:layers', (_event, dshId: string, name: string): IpcResult<ProfileLayer[]> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    return { ok: true, value: composeProfileLayers(ctx, name) }
  })

  // Loader entry ids inserted by more than one composed layer. The host
  // hard-fails on a repeated insert id, so the UI surfaces it before launch.
  handle('profile:conflicts', (_event, dshId: string, name: string): IpcResult<InsertConflict[]> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    return { ok: true, value: findInsertConflicts(ctx, name) }
  })

  // ── source mode: raw file access + composition validation ───────────────
  handle('profile:readFile', (_event, dshId: string, name: string, kind: ProfileFileKind): IpcResult<{ text: string; path: string }> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    if (kind !== 'manifest' && kind !== 'patch') return fail(E.nameInvalid)
    return { ok: true, value: readProfileFile(ctx, name, kind) }
  })

  // Pre-launch composition check (parse + layers + conflicts + bundles).
  handle('profile:validate', (_event, dshId: string, name: string): IpcResult<ProfileValidation> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    return { ok: true, value: validateComposition(ctx, name) }
  })

  // Reveal a profile's directory in the OS file explorer.
  handle('profile:reveal', async (_event, dshId: string, name: string): Promise<IpcResult<boolean>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    const dir = profileDirPath(ctx, name)
    if (!existsSync(dir)) return fail(E.profileNotFound, { profile: name })
    const error = await shell.openPath(dir)
    return error === '' ? { ok: true, value: true } : fail(E.shellOpenPath, { detail: error })
  })

  // Default (bundle) vs current (profile layer) config for one row — for the
  // two-pane diff editor.
  handle('profile:configInfo', (_event, dshId: string, name: string, id: string): IpcResult<{ default: string; current: string }> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    const def = defaultConfigText(ctx, name, id)
    let current = ''
    const patchPath = profilePatchPath(ctx, name)
    if (existsSync(patchPath)) {
      const v = extractKeyValue(readFileSync(patchPath, 'utf8'), id, 'config')
      if (v !== undefined) current = v
    }
    return { ok: true, value: { default: def, current } }
  })

  // The profile's locally-linked bundles — the renderer asks before exporting to
  // decide whether to pack their code into a zip.
  handle('profile:localBundles', (_event, dshId: string, name: string): IpcResult<string[]> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    return { ok: true, value: listLocalBundles(ctx, name, pluginDir()).map(b => b.name) }
  })
}
