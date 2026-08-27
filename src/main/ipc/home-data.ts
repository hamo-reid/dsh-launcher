/** IPC for DSH data export / import / cross-version migration (`data:*`).
 * Thin wrapper over `core/home-data`: pick a file with the native dialog, then
 * archive / restore / mirror the dsh's migratable home data + profiles. */

import { dialog } from 'electron'
import { handle } from './handle.ts'
import AdmZip from 'adm-zip'
import { contextForEntry, readDshState, type DshContext } from '../core/appState.ts'
import { exportDshData, importDshData, mirrorDshData } from '../core/home-data.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import type { DshDataImportResult, DshDataManifest, DshEntry, IpcResult } from '../../shared/types.ts'

/** The registered entry + its context for `id`, or `undefined`. */
function entryFor(id: string): { entry: DshEntry; ctx: DshContext } | undefined {
  const entry = readDshState().dshes.find(d => d.id === id)
  if (entry === undefined) return undefined
  return { entry, ctx: contextForEntry(entry) }
}

export function registerHomeDataIpc(): void {
  // Export a dsh's migratable data to a user-chosen zip. `''` when cancelled.
  handle('data:export', async (_event, id: string): Promise<IpcResult<string>> => {
    try {
      const s = entryFor(id)
      if (s === undefined) return fail(E.dshNotFound)
      const picked = await dialog.showSaveDialog({
        title: '导出 DSH 数据',
        defaultPath: `dsh-data-${s.entry.name}.zip`,
        filters: [{ name: 'DSH 数据', extensions: ['zip'] }],
      })
      if (picked.canceled || picked.filePath === '') return { ok: true, value: '' }
      exportDshData(s.ctx, picked.filePath)
      return { ok: true, value: picked.filePath }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Let the user pick an archive and read its manifest (for the cross-version
  // gate before import). `file` is `''` when cancelled.
  handle('data:inspectImport', async (): Promise<IpcResult<{ file: string; manifest: DshDataManifest | null }>> => {
    try {
      const picked = await dialog.showOpenDialog({
        title: '选择要导入的 DSH 数据包',
        properties: ['openFile'],
        filters: [{ name: 'DSH 数据', extensions: ['zip'] }],
      })
      if (picked.canceled || picked.filePaths.length === 0) {
        return { ok: true, value: { file: '', manifest: null } }
      }
      const file = picked.filePaths[0]
      let manifest: DshDataManifest | null = null
      const entry = new AdmZip(file).getEntry('data-manifest.json')
      if (entry !== undefined && entry !== null) {
        try { manifest = JSON.parse(entry.getData().toString('utf8')) as DshDataManifest } catch { /* unreadable */ }
      }
      return { ok: true, value: { file, manifest } }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Import an archive into a dsh's home. Cross-major requires `forceDsh`.
  handle('data:import', (_event, id: string, file: string, forceDsh?: boolean): IpcResult<DshDataImportResult> => {
    try {
      const s = entryFor(id)
      if (s === undefined) return fail(E.dshNotFound)
      return { ok: true, value: importDshData(s.ctx, file, { forceDsh }) }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Directly mirror one dsh's data into another dsh's home (no zip). The UI
  // gates the cross-major confirmation against both versions beforehand.
  handle('data:mirror', (_event, sourceId: string, targetId: string): IpcResult<DshDataImportResult> => {
    try {
      const src = entryFor(sourceId)
      const tgt = entryFor(targetId)
      if (src === undefined || tgt === undefined) return fail(E.dshNotFound)
      return { ok: true, value: mirrorDshData(src.ctx, tgt.ctx) }
    } catch (error) {
      return failFromError(error)
    }
  })
}