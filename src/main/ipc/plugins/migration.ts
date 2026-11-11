/** Store-migration IPC (`store:*`): a read-only probe plus an explicit migrate
 * that the renderer only calls after the user consents to a one-time legacy →
 * versioned layout migration at startup. Migration logic lives in plugins.ts. */

import { handle } from '../handle.ts'
import { migrateStore, needsStoreMigration } from '../../core/store/plugins.ts'
import { pluginDir } from '../../core/profile/appState.ts'
import { listRuns } from '../dsh/run.ts'
import { fail, failFromError, E } from '../../core/shared/errors.ts'
import { logger } from '../../core/shared/logger.ts'
import type { IpcResult } from '../../../shared/types.ts'

export function registerStoreIpc(): void {
  /** True when the store still holds legacy flat packages awaiting migration. */
  handle('store:needsMigration', (): IpcResult<boolean> => {
    try {
      return { ok: true, value: needsStoreMigration(pluginDir()) }
    } catch (error) {
      return failFromError(error)
    }
  })

  /** Run the one-time migration (moves legacy packages into versions and
   * retargets profiles that link into a moved path). Idempotent. */
  handle('store:migrate', async (): Promise<IpcResult<{ migrated: boolean }>> => {
    try {
      // The migration moves packages into the versioned layout AND retargets the
      // profile manifests that point at the old paths. A live process would keep
      // loading the old path, so it cannot be done underneath one. This normally
      // runs once at startup before any run exists — a second launcher instance
      // is the case this refuses; it is not an offer because there is no page to
      // answer one on.
      const busy = listRuns()
      if (busy.length > 0) {
        return fail(E.runAlreadyRunning, { profile: busy.map(run => run.profile).join('、') })
      }
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