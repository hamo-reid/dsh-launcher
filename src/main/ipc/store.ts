/** Store-migration IPC (`store:*`): a read-only probe plus an explicit migrate
 * that the renderer only calls after the user consents to a one-time legacy →
 * versioned layout migration at startup. Migration logic lives in plugins.ts. */

import { ipcMain } from 'electron'
import { migrateStore, needsStoreMigration } from '../core/plugins.ts'
import { pluginDir } from '../core/appState.ts'
import { failFromError } from '../core/errors.ts'
import { logger } from '../core/logger.ts'
import type { IpcResult } from '../../shared/types.ts'

export function registerStoreIpc(): void {
  /** True when the store still holds legacy flat packages awaiting migration. */
  ipcMain.handle('store:needsMigration', (): IpcResult<boolean> => {
    try {
      return { ok: true, value: needsStoreMigration(pluginDir()) }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Run the one-time migration (moves legacy packages into versions and
   * retargets profiles that link into a moved path). Idempotent. */
  ipcMain.handle('store:migrate', async (): Promise<IpcResult<{ migrated: boolean }>> => {
    try {
      const before = needsStoreMigration(pluginDir())
      logger.info('store:migrate: begin')
      await migrateStore(pluginDir())
      logger.info(`store:migrate: done (migrated=${before})`)
      return { ok: true, value: { migrated: before } }
    } catch (error) {
      logger.error('store:migrate error', error)
      return failFromError(error)
    }
  })
}