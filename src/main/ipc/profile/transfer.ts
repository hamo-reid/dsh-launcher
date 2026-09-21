/** Moving a profile in and out of the launcher: portable export, the zip round-trip, and the cross-dsh mirror. */


import { app, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import AdmZip from 'adm-zip'
import { exportProfile, importProfile, listLocalBundles, mirrorProfile } from '../../core/profile/profile.ts'
import { contextForEntry, dshEntryById, pluginDir } from '../../core/profile/appState.ts'
import { addDirToZip } from '../../core/shared/app-util.ts'
import { fail, E } from '../../core/shared/errors.ts'
import { ctxOf } from '../ctxOf.ts'
import { handle } from '../handle.ts'
import { importTmpRoot, invalidName } from './helpers.ts'
import { pathOutsideRoot } from '../validate.ts'
import type { ImportProfileResult, IpcResult } from '../../../shared/types.ts'



/** Validate a config value is a YAML mapping. Structure only, so a cordis
 * `!!js` reference (which the schema cannot resolve) is not misread as bad
 * YAML. Throws with a friendly message. */

export function registerProfileTransferIpc(): void {
  handle('profile:export', (_event, dshId: string, name: string): IpcResult<string> => {
    const ctx = ctxOf(dshId)
    if (ctx === null) return fail(E.dshNotFound)
    if (invalidName(name)) return fail(E.nameInvalid)
    return { ok: true, value: exportProfile(ctx, name) }
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
}
