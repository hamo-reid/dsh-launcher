/** IPC for profile instance management + the profile/copy/reconcile patch
 * layer (`profile:*`). */

import { app, dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import AdmZip from 'adm-zip'
import yaml from 'js-yaml'
import { listProfiles, profileDir } from '../core/home.ts'
import { readManifest } from '../core/manifest.ts'
import {
  appendRowBlock, extractKeyValue, extractRowBlock, parsePatchRows, removeRow, setRowConfig, setRowDisabled, upsertRow,
} from '../core/patch.ts'
import {
  composeProfileLayers, defaultConfigText, listUnclaimedBundles, reconcileBundles, resolveBundlePatch,
} from '../core/combo.ts'
import {
  cloneProfile, createProfile, exportProfile, importProfile, listLocalBundles, listProfileSummaries,
  mirrorProfile, PROFILE_TEMPLATES, removeBundle, reorderBundle, softDeleteProfile, type ProfileSummary,
} from '../core/profile.ts'
import { contextForEntry, pluginDir, readDshState } from '../core/appState.ts'
import { addDirToZip, dedentRowBlock, verifyDisabledState } from '../core/app-util.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import type {
  ImportProfileResult, IpcResult, ProfileDetail, ProfileLayer, RowCreateInput,
} from '../../shared/types.ts'

/** Validate a config value is a YAML mapping (FAILSAFE: structure only, so
 * cordis `!!js` tags are not misread). Throws with a friendly message. */
function assertConfigValid(configText: string): void {
  let parsed: unknown
  try {
    parsed = yaml.load(configText, { schema: yaml.FAILSAFE_SCHEMA })
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
    yaml.load(items.map(item => `- ${item}`).join('\n'), { schema: yaml.FAILSAFE_SCHEMA })
  } catch (error) {
    throw new Error(`insert 不是合法 YAML 列表：${String(error instanceof Error ? error.message : error)}`)
  }
}

/** Validate a fully-assembled patch document before it is written. A malformed
 * result (e.g. a row nested as a child of a scalar key) must never reach disk.
 * Files carrying cordis `!!js` tags skip the deep check so a custom tag is not
 * misread as bad YAML. */
function assertPatchDocValid(next: string): void {
  if (next.includes('!!js')) return
  let parsed: unknown
  try {
    parsed = yaml.load(next, { schema: yaml.FAILSAFE_SCHEMA })
  } catch (error) {
    throw new Error(`生成的 patch 不是合法 YAML，已拒绝写入：${String(error instanceof Error ? error.message : error)}`)
  }
  // dsh 要求 patch 顶层是 loader-patch 条目数组。空文档(只有注释 → null)、对象、标量
  // 都会在启动时检查失败,必须在写入前拒绝——否则会静默写坏,到启动才暴露。
  if (!Array.isArray(parsed)) {
    throw new Error('生成的 patch 顶层必须是 YAML 数组（loader patch 条目列表），已拒绝写入')
  }
}

const writeUserPatch = (name: string, next: string): void => {
  // Guard against a bad assembly ever reaching disk.
  assertPatchDocValid(next)
  const path = join(profileDir(name), 'cordis.patch.yml')
  writeFileSync(path, next)
  if (readFileSync(path, 'utf8') !== next) throw new Error('write verify failed')
}

/** Read a profile's detail (manifest + user-patch rows). */
function loadProfileDetail(name: string): ProfileDetail {
  const { bundles, dependencies } = readManifest(name)
  const patchPath = join(profileDir(name), 'cordis.patch.yml')
  const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  return { bundles, dependencies, rows: parsePatchRows(patchText), patchText }
}

export function registerProfileIpc(): void {
  ipcMain.handle('profile:list', (): IpcResult<string[]> => {
    try {
      return { ok: true, value: listProfiles() }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('profile:load', (_event, name: string): IpcResult<ProfileDetail> => {
    try {
      return { ok: true, value: loadProfileDetail(name) }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle(
    'profile:setDisabled',
    (_event, name: string, id: string, disabled: boolean): IpcResult<boolean> => {
      try {
        const patchPath = join(profileDir(name), 'cordis.patch.yml')
        const current = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '[]'
        writeFileSync(patchPath, setRowDisabled(current, id, disabled))
        // Write-then-read verify: the patch must parse and the row must hold the
        // requested state. Never report success on a silently wrong file.
        const after = readFileSync(patchPath, 'utf8')
        if (verifyDisabledState(after, id, disabled)) return { ok: true, value: true }
        return fail('patch.writeVerify', { id })
      } catch (error) {
        return failFromError(error)
      }
    },
  )

  // ── profile instances ────────────────────────────────────────────────
  ipcMain.handle('profile:summaries', (): IpcResult<ProfileSummary[]> => {
    try {
      return { ok: true, value: listProfileSummaries() }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('profile:create', (_event, name: string, template?: string): IpcResult<boolean> => {
    try {
      // `template`: official keys prefixed `template:` (base/web), or an existing
      // profile name to clone. Empty → default base.
      const OFFICIAL_PREFIX = 'template:'
      if (template !== undefined && template.startsWith(OFFICIAL_PREFIX)) {
        const key = template.slice(OFFICIAL_PREFIX.length)
        if (!(key in PROFILE_TEMPLATES)) throw new Error(`unknown template "${key}"`)
        createProfile(name, PROFILE_TEMPLATES[key])
      } else if (template !== undefined && template !== '') {
        cloneProfile(template, name)
      } else {
        createProfile(name)
      }
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('profile:clone', (_event, name: string, newName: string): IpcResult<boolean> => {
    try {
      cloneProfile(name, newName)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('profile:delete', (_event, name: string): IpcResult<boolean> => {
    try {
      softDeleteProfile(name)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('profile:export', (_event, name: string): IpcResult<string> => {
    try {
      return { ok: true, value: exportProfile(name) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // The profile's locally-linked bundles — the renderer asks before exporting to
  // decide whether to pack their code into a zip.
  ipcMain.handle('profile:localBundles', (_event, name: string): IpcResult<string[]> => {
    try {
      return { ok: true, value: listLocalBundles(name, pluginDir()).map(b => b.name) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Save a profile's export to a user-chosen file: `.json` (config only), or
  // `.zip` (config + packed local plugin code) when `opts.zip` is set.
  ipcMain.handle('profile:exportToFile', async (_event, name: string, opts?: { zip?: boolean }): Promise<IpcResult<string>> => {
    try {
      const json = exportProfile(name)
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
        for (const b of listLocalBundles(name, pluginDir())) addDirToZip(arc, b.dir, `plugins/${b.name}`)
        writeFileSync(picked.filePath, arc.toBuffer())
      } else {
        writeFileSync(picked.filePath, json)
      }
      return { ok: true, value: picked.filePath }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Pick a profile export — `.json` or `.zip`. A zip is unpacked (config +
  // `plugins/`) to a temp dir that the import then consumes; `unpackDir` is
  // where those live, `''` for a plain json. dshVersion lets the UI gate early.
  ipcMain.handle('profile:importFromFile', async (): Promise<IpcResult<{ json: string; name: string; dshVersion: string; unpackDir: string }>> => {
    try {
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
    } catch (error) {
      return failFromError(error)
    }
  })

  // Import an exported profile. `localSource` is the unpacked zip dir (`''` for
  // a json) whose `plugins/*` restore local bundles offline; dsh mismatch is
  // refused unless `forceDsh`. Temp unpack dir is cleaned up afterwards.
  ipcMain.handle('profile:import', async (event, json: string, name?: string, forceDsh?: boolean, localSource?: string): Promise<IpcResult<ImportProfileResult>> => {
    try {
      const result = await importProfile(json, { name, forceDsh, localSource },
        step => event.sender.send('import:event', step))
      if (localSource !== undefined && localSource !== '') rmSync(localSource, { recursive: true, force: true })
      return { ok: true, value: result }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Copy a profile from one dsh to another (cross-version profile migration).
  // Source stays intact; target rebuilds the bundle layers under its own dsh.
  ipcMain.handle('profile:mirror', async (event, sourceDshId: string, targetDshId: string, profileName: string): Promise<IpcResult<ImportProfileResult>> => {
    try {
      const { dshes } = readDshState()
      const src = dshes.find(d => d.id === sourceDshId)
      const tgt = dshes.find(d => d.id === targetDshId)
      if (src === undefined || tgt === undefined) return fail(E.dshNotFound)
      const result = await mirrorProfile(contextForEntry(src), contextForEntry(tgt), profileName,
        {}, step => event.sender.send('import:event', step))
      return { ok: true, value: result }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('profile:missingBundles', (_event, name: string): IpcResult<string[]> => {
    try {
      return { ok: true, value: listUnclaimedBundles(name) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // The composition stack: bundle layers in order, then profile, then home.
  ipcMain.handle('profile:layers', (_event, name: string): IpcResult<ProfileLayer[]> => {
    try {
      return { ok: true, value: composeProfileLayers(name) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Create / update a row (pure id, disabled, config override, or insert) on the
  // profile's own patch layer. Content is YAML-validated before writing.
  ipcMain.handle('profile:addRow', (_event, name: string, row: RowCreateInput): IpcResult<boolean> => {
    try {
      const id = row.id.trim()
      if (id === '') return fail(E.nameInvalid)
      if (row.config !== undefined && row.config.trim() !== '') assertConfigValid(row.config)
      if (row.insert !== undefined && row.insert.length > 0) assertInsertValid(row.insert)
      const path = join(profileDir(name), 'cordis.patch.yml')
      const current = existsSync(path) ? readFileSync(path, 'utf8') : '[]'
      writeUserPatch(name, upsertRow(current, { ...row, id }))
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Remove a row's override from the profile layer (restores the bundle default).
  ipcMain.handle('profile:removeRow', (_event, name: string, id: string): IpcResult<boolean> => {
    try {
      const path = join(profileDir(name), 'cordis.patch.yml')
      if (!existsSync(path)) return fail('patch.nothingToRemove')
      writeUserPatch(name, removeRow(readFileSync(path, 'utf8'), id))
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Copy a bundle row verbatim into the profile layer, so the user can then
  // override it there. The bundle package itself is never modified.
  ipcMain.handle('profile:copyRow', (_event, name: string, bundle: string, id: string): IpcResult<boolean> => {
    try {
      const src = resolveBundlePatch(bundle, name)
      if (src === undefined) return fail(E.bundleNotFound, { bundle })
      const block = extractRowBlock(readFileSync(src, 'utf8'), id)
      if (block === undefined) return fail('bundle.noRow', { bundle, id })
      const path = join(profileDir(name), 'cordis.patch.yml')
      const current = existsSync(path) ? readFileSync(path, 'utf8') : '[]'
      // The source row may sit nested under a group (extra leading indent);
      // re-base it to the top level so the copy stands as a valid top-level row.
      writeUserPatch(name, appendRowBlock(current, dedentRowBlock(block)))
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Edit an existing row's config block in the profile layer.
  ipcMain.handle('profile:setRowConfig', (_event, name: string, id: string, configText: string): IpcResult<boolean> => {
    try {
      const path = join(profileDir(name), 'cordis.patch.yml')
      const current = existsSync(path) ? readFileSync(path, 'utf8') : '[]'
      writeUserPatch(name, setRowConfig(current, id, configText))
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('profile:removeBundle', async (_event, name: string, bundle: string): Promise<IpcResult<boolean>> => {
    try {
      await removeBundle(name, bundle)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Move one bundle layer to `toIndex` within `dsh.profile.bundles`.
  ipcMain.handle('profile:reorderBundle', (_event, name: string, bundle: string, toIndex: number): IpcResult<boolean> => {
    try {
      if (!Number.isInteger(toIndex)) return fail('name.invalid', [], 'toIndex 必须是整数')
      reorderBundle(name, bundle, toIndex)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Manually re-reconcile the bundles layer against installed state.
  ipcMain.handle('profile:reconcile', (_event, name: string): IpcResult<{ added: string[]; removed: string[] }> => {
    try {
      return { ok: true, value: reconcileBundles(name) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Default (bundle) vs current (profile layer) config for one row — for the
  // two-pane diff editor.
  ipcMain.handle('profile:configInfo', (_event, name: string, id: string): IpcResult<{ default: string; current: string }> => {
    try {
      const def = defaultConfigText(name, id)
      const patchPath = join(profileDir(name), 'cordis.patch.yml')
      let current = ''
      if (existsSync(patchPath)) {
        const v = extractKeyValue(readFileSync(patchPath, 'utf8'), id, 'config')
        if (v !== undefined) current = v
      }
      return { ok: true, value: { default: def, current } }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Open the profile's `cordis.patch.yml` in the OS default editor, so the user
  // can hand-edit / repair it. Creates an empty overlay if it is missing.
  ipcMain.handle('profile:openPatchSource', async (_event, name: string): Promise<IpcResult<boolean>> => {
    try {
      const path = join(profileDir(name), 'cordis.patch.yml')
      if (!existsSync(path)) writeFileSync(path, '[]\n')
      const error = await shell.openPath(path)
      return error === '' ? { ok: true, value: true } : fail('shell.openPath', { detail: error })
    } catch (error) {
      return failFromError(error)
    }
  })
}