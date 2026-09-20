/** IPC for profile instance management + the profile/copy/reconcile patch
 * layer (`profile:*`). Every handler takes an explicit `dshId` — there is no
 * global active dsh — and resolves it to a {@link DshContext}. */

import { app, dialog, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import AdmZip from 'adm-zip'
import { load as loadYaml, FAILSAFE_SCHEMA } from 'js-yaml'
import { listProfiles, profileDir } from '../core/home.ts'
import { readManifest } from '../core/manifest.ts'
import {
  appendRowBlock, assertPatchDocValid, extractKeyValue, extractRowBlock, parsePatchRows, removeRow,
  setRowConfig, setRowDisabled, upsertRow,
} from '../core/patch.ts'
import {
  composeProfileLayers, defaultConfigText, findInsertConflicts, listUnclaimedBundles, reconcileBundles,
  resolveBundlePatch, validateComposition,
} from '../core/combo.ts'
import {
  addBundle, cloneProfile, createProfile, exportProfile, importProfile, listLocalBundles, listProfileSummaries,
  mirrorProfile, PROFILE_TEMPLATES, profileBundleInfo, profileDirPath, readProfileFile, removeBundle, removeDependency,
  renameProfile, reorderBundle, setDependency, setManifestMeta, softDeleteProfile, transferProfilePatch, writeProfileFile,
  type ProfileSummary,
} from '../core/profile.ts'
import { contextForEntry, dshEntryById, pluginDir, type DshContext } from '../core/appState.ts'
import { addDirToZip, dedentRowBlock, verifyDisabledState } from '../core/app-util.ts'
import { fail, E } from '../core/errors.ts'
import { handle } from './handle.ts'
import { isProfileRunning } from './run.ts'
import { pathIdentifierInvalid, pathOutsideRoot, rowIdInvalid } from './validate.ts'
import type {
  ImportProfileResult, InsertConflict, IpcResult, ProfileDetail, ProfileFileKind, ProfileLayer,
  ProfilePatchReload, ProfileValidation, RowCreateInput,
} from '../../shared/types.ts'

/** Validate a config value is a YAML mapping (FAILSAFE: structure only, so
 * cordis `!!js` tags are not misread). Throws with a friendly message. */
function assertConfigValid(configText: string): void {
  let parsed: unknown
  try {
    parsed = loadYaml(configText, { schema: FAILSAFE_SCHEMA })
  } catch (error) {
    throw new Error(`config 不是合法 YAML：${String(error instanceof Error ? error.message : error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config 必须是对象（YAML 映射）')
  }
}

/** Validate an insert list reads as a YAML sequence. */
function assertInsertValid(items: string[]): void {
  try {
    loadYaml(items.map(item => `- ${item}`).join('\n'), { schema: FAILSAFE_SCHEMA })
  } catch (error) {
    throw new Error(`insert 不是合法 YAML 列表：${String(error instanceof Error ? error.message : error)}`)
  }
}

/** Resolve an explicit dsh id to its context, or `null` when unknown. */
function ctxOf(dshId: unknown): DshContext | null {
  if (typeof dshId !== 'string') return null
  const entry = dshEntryById(dshId)
  return entry === undefined ? null : contextForEntry(entry)
}

/** Resolve a profile's `cordis.patch.yml` path (single source of the filename). */
function patchPathOf(ctx: DshContext, name: string): string {
  return join(profileDir(ctx, name), 'cordis.patch.yml')
}

/** Read a profile's patch layer, defaulting to an empty document. */
function readUserPatch(ctx: DshContext, name: string): string {
  const path = patchPathOf(ctx, name)
  return existsSync(path) ? readFileSync(path, 'utf8') : '[]'
}

const writeUserPatch = (ctx: DshContext, name: string, next: string): void => {
  // Guard against a bad assembly ever reaching disk.
  assertPatchDocValid(next)
  const path = patchPathOf(ctx, name)
  writeFileSync(path, next)
  if (readFileSync(path, 'utf8') !== next) throw new Error('write verify failed')
}

/** Read a profile's detail (manifest + user-patch rows). */
function loadProfileDetail(ctx: DshContext, name: string): ProfileDetail {
  const { bundles, dependencies } = readManifest(ctx, name)
  // Read the raw manifest for the fields the manifest reader does not expose.
  let dependencySpecs: Record<string, string> = {}
  let displayName = name
  let patchReload: ProfilePatchReload = 'live'
  try {
    const raw = JSON.parse(readFileSync(join(profileDir(ctx, name), 'package.json'), 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
      dsh?: { profile?: { patchReload?: ProfilePatchReload } }
    }
    dependencySpecs = raw.dependencies ?? {}
    if (typeof raw.name === 'string' && raw.name !== '') displayName = raw.name
    if (raw.dsh?.profile?.patchReload === 'startup') patchReload = 'startup'
  } catch {
    // A malformed manifest still yields a detail; the source editor surfaces it.
  }
  // The raw view keeps `''` (not `[]`) for a missing layer, unlike the write path.
  const patchText = existsSync(patchPathOf(ctx, name)) ? readFileSync(patchPathOf(ctx, name), 'utf8') : ''
  return {
    bundles, dependencies, dependencySpecs,
    bundleInfo: profileBundleInfo(ctx, name, bundles, dependencySpecs, pluginDir()),
    displayName, patchReload, rows: parsePatchRows(patchText), patchText,
  }
}

/** A profile/bundle name from IPC must be a safe path token: it feeds
 * `profileDir(ctx, name)` / `join(profilesDir(ctx), name, …)`, so an unguarded
 * `..`, `\`, absolute path or drive prefix could read/write/rename/delete
 * OUTSIDE the profiles tree. Mirrors the guard `plugins`/`trash` apply. */
function invalidName(name: unknown): boolean {
  return typeof name !== 'string' || pathIdentifierInvalid(name)
}

/** Where the zip-import flow may leave unpacked data for cleanup. */
function importTmpRoot(): string {
  return join(app.getPath('userData'), 'import-tmp')
}

export function registerProfileIpc(): void {
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

  handle(
    'profile:setDisabled',
    (_event, dshId: string, name: string, id: string, disabled: boolean): IpcResult<boolean> => {
      const ctx = ctxOf(dshId)
      if (ctx === null) return fail(E.dshNotFound)
      if (invalidName(name)) return fail(E.nameInvalid)
      // A row id that could break/extend the `- id: <value>` line must never be
      // written into the patch doc.
      if (rowIdInvalid(id)) return fail(E.nameInvalid)
      // Go through writeUserPatch so every write path shares the document-level
      // assertPatchDocValid guard, then keep the row-specific verify below.
      writeUserPatch(ctx, name, setRowDisabled(readUserPatch(ctx, name), id, disabled))
      // Write-then-read verify: the patch must parse and the row must hold the
      // requested state. Never report success on a silently wrong file.
      const after = readUserPatch(ctx, name)
      if (verifyDisabledState(after, id, disabled)) return { ok: true, value: true }
      return fail(E.patchWriteVerify, { id })
    },
  )

  // ── profile instances ────────────────────────────────────────────────
  handle('profile:summaries', (_event, dshId: string): IpcResult<ProfileSummary[]> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    // Flag live profiles so the list can show "running" and refuse a delete.
    return { ok: true, value: listProfileSummaries(ctx).map(s => ({ ...s, running: isProfileRunning(dshId, s.name) })) }
  })

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

  handle('profile:export', (_event, dshId: string, name: string): IpcResult<string> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    return { ok: true, value: exportProfile(ctx, name) }
  })

  // The profile's locally-linked bundles — the renderer asks before exporting to
  // decide whether to pack their code into a zip.
  handle('profile:localBundles', (_event, dshId: string, name: string): IpcResult<string[]> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    return { ok: true, value: listLocalBundles(ctx, name, pluginDir()).map(b => b.name) }
  })

  // Save a profile's export to a user-chosen file: `.json` (config only), or
  // `.zip` (config + packed local plugin code) when `opts.zip` is set.
  handle('profile:exportToFile', async (_event, dshId: string, name: string, opts?: { zip?: boolean }): Promise<IpcResult<string>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    const json = exportProfile(ctx, name)
    const zip = opts?.zip === true
    const picked = await dialog.showSaveDialog({
      title: `导出 ${name}`,
      defaultPath: zip ? `${name}.zip` : `${name}.json`,
      filters: zip ? [{ name: '存档', extensions: ['zip'] }] : [{ name: 'JSON', extensions: ['json'] }],
    })
    if (picked.canceled || picked.filePath === '') return { ok: true, value: '' } // 用户取消，不报错
    if (zip) {
      const arc = new AdmZip()
      arc.addFile('profile.json', Buffer.from(json, 'utf8'))
      for (const b of listLocalBundles(ctx, name, pluginDir())) addDirToZip(arc, b.dir, `plugins/${b.name}`)
      writeFileSync(picked.filePath, arc.toBuffer())
    } else {
      writeFileSync(picked.filePath, json)
    }
    return { ok: true, value: picked.filePath }
  })

  // Pick a profile export — `.json` or `.zip`. A zip is unpacked (config +
  // `plugins/`) to a temp dir that the import then consumes; `unpackDir` is
  // where those live, `''` for a plain json. dshVersion lets the UI gate early.
  handle('profile:importFromFile', async (): Promise<IpcResult<{ json: string; name: string; dshVersion: string; unpackDir: string }>> => {
    const picked = await dialog.showOpenDialog({
      title: '选择要导入的 profile 导出文件',
      properties: ['openFile'],
      filters: [{ name: 'Profile 导出', extensions: ['json', 'zip'] }],
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: true, value: { json: '', name: '', dshVersion: '', unpackDir: '' } }
    const file = picked.filePaths[0]
    let unpackDir = ''
    let json: string
    if (file.toLowerCase().endsWith('.zip')) {
      const base = basename(file).replace(/\.zip$/i, '') || 'profile'
      unpackDir = join(app.getPath('userData'), 'import-tmp', base)
      rmSync(unpackDir, { recursive: true, force: true })
      mkdirSync(unpackDir, { recursive: true })
      new AdmZip(file).extractAllTo(unpackDir, true)
      const entry = join(unpackDir, 'profile.json')
      if (!existsSync(entry)) throw new Error('zip 内缺少 profile.json')
      json = readFileSync(entry, 'utf8')
    } else {
      json = readFileSync(file, 'utf8')
    }
    let name = ''
    let dshVersion = ''
    try {
      const parsed = JSON.parse(json) as { name?: unknown; dshVersion?: unknown }
      name = typeof parsed.name === 'string' ? parsed.name : ''
      dshVersion = typeof parsed.dshVersion === 'string' ? parsed.dshVersion : ''
    } catch { /* 预览用；解析失败由导入兜底 */ }
    return { ok: true, value: { json, name, dshVersion, unpackDir } }
  })

  // Import an exported profile into an explicit dsh. `localSource` is the
  // unpacked zip dir (`''` for a json) whose `plugins/*` restore local bundles
  // offline; dsh mismatch is refused unless `forceDsh`. Temp unpack dir is
  // cleaned up afterwards.
  handle('profile:import', async (event, dshId: string, json: string, name?: string, forceDsh?: boolean, localSource?: string): Promise<IpcResult<ImportProfileResult>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (name !== undefined && name !== '' && invalidName(name)) return fail(E.nameInvalid)
    // `localSource` is only ever the unpacked zip dir under `import-tmp`; refuse
    // any other path so the recursive cleanup below can never touch user data.
    if (localSource !== undefined && localSource !== '' && pathOutsideRoot(importTmpRoot(), localSource)) {
      return fail(E.nameInvalid)
    }
    const result = await importProfile(ctx, json, { name, forceDsh, localSource },
      step => event.sender.send('import:event', step))
    if (localSource !== undefined && localSource !== '') rmSync(localSource, { recursive: true, force: true })
    return { ok: true, value: result }
  })

  // Copy a profile from one dsh to another (cross-version profile migration).
  // Source stays intact; target rebuilds the bundle layers under its own dsh.
  handle('profile:mirror', async (event, sourceDshId: string, targetDshId: string, profileName: string): Promise<IpcResult<ImportProfileResult>> => {
    const src = dshEntryById(sourceDshId)
    const tgt = dshEntryById(targetDshId)
    if (src === undefined || tgt === undefined) return fail(E.dshNotFound)
    if (invalidName(profileName)) return fail(E.nameInvalid)
    const result = await mirrorProfile(contextForEntry(src), contextForEntry(tgt), profileName,
      {}, step => event.sender.send('import:event', step))
    return { ok: true, value: result }
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

  handle('profile:writeFile', (_event, dshId: string, name: string, kind: ProfileFileKind, text: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    if (kind !== 'manifest' && kind !== 'patch') return fail(E.nameInvalid)
    writeProfileFile(ctx, name, kind, text)
    return { ok: true, value: true }
  })

  // Pre-launch composition check (parse + layers + conflicts + bundles).
  handle('profile:validate', (_event, dshId: string, name: string): IpcResult<ProfileValidation> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    return { ok: true, value: validateComposition(ctx, name) }
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

  handle('profile:setManifest', (_event, dshId: string, name: string, meta: { displayName?: string; patchReload?: ProfilePatchReload }): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    setManifestMeta(ctx, name, meta)
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

  // Create / update a row (pure id, disabled, config override, or insert) on the
  // profile's own patch layer. Content is YAML-validated before writing.
  handle('profile:addRow', (_event, dshId: string, name: string, row: RowCreateInput): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    const id = row.id.trim()
    if (rowIdInvalid(id)) return fail(E.nameInvalid)
    if (row.config !== undefined && row.config.trim() !== '') assertConfigValid(row.config)
    if (row.insert !== undefined && row.insert.length > 0) assertInsertValid(row.insert)
    writeUserPatch(ctx, name, upsertRow(readUserPatch(ctx, name), { ...row, id }))
    return { ok: true, value: true }
  })

  // Remove a row's override from the profile layer (restores the bundle default).
  handle('profile:removeRow', (_event, dshId: string, name: string, id: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    if (!existsSync(patchPathOf(ctx, name))) return fail(E.patchNothingToRemove)
    writeUserPatch(ctx, name, removeRow(readUserPatch(ctx, name), id))
    return { ok: true, value: true }
  })

  // Copy a bundle row verbatim into the profile layer, so the user can then
  // override it there. The bundle package itself is never modified.
  handle('profile:copyRow', (_event, dshId: string, name: string, bundle: string, id: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name) || invalidName(bundle)) return fail(E.nameInvalid)
    const src = resolveBundlePatch(ctx, bundle, name)
    if (src === undefined) return fail(E.bundleNotFound, { bundle })
    const block = extractRowBlock(readFileSync(src, 'utf8'), id)
    if (block === undefined) return fail(E.bundleNoRow, { bundle, id })
    // The source row may sit nested under a group (extra leading indent);
    // re-base it to the top level so the copy stands as a valid top-level row.
    writeUserPatch(ctx, name, appendRowBlock(readUserPatch(ctx, name), dedentRowBlock(block)))
    return { ok: true, value: true }
  })

  // Edit an existing row's config block in the profile layer.
  handle('profile:setRowConfig', (_event, dshId: string, name: string, id: string, configText: string): IpcResult<boolean> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    writeUserPatch(ctx, name, setRowConfig(readUserPatch(ctx, name), id, configText))
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

  // Manually re-reconcile the bundles layer against installed state.
  handle('profile:reconcile', (_event, dshId: string, name: string): IpcResult<{ added: string[]; removed: string[] }> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    return { ok: true, value: reconcileBundles(ctx, name) }
  })

  // Default (bundle) vs current (profile layer) config for one row — for the
  // two-pane diff editor.
  handle('profile:configInfo', (_event, dshId: string, name: string, id: string): IpcResult<{ default: string; current: string }> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    const def = defaultConfigText(ctx, name, id)
    let current = ''
    const patchPath = patchPathOf(ctx, name)
    if (existsSync(patchPath)) {
      const v = extractKeyValue(readFileSync(patchPath, 'utf8'), id, 'config')
      if (v !== undefined) current = v
    }
    return { ok: true, value: { default: def, current } }
  })

  // Open the profile's `cordis.patch.yml` in the OS default editor, so the user
  // can hand-edit / repair it. Creates an empty overlay if it is missing.
  handle('profile:openPatchSource', async (_event, dshId: string, name: string): Promise<IpcResult<boolean>> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    const path = patchPathOf(ctx, name)
    if (!existsSync(path)) writeFileSync(path, '[]\n')
    const error = await shell.openPath(path)
    return error === '' ? { ok: true, value: true } : fail(E.shellOpenPath, { detail: error })
  })
}
