/** IPC for the community market (`market:*`): catalog fetch, loading-route
 * picker, and install-target resolution. Business logic lives in market.ts;
 * this file only wires the channels and reports failures the launcher way. */

import { ipcMain } from 'electron'
import { installSpecFor, loadMarket, marketSourceState, setMarketSourceState } from '../core/market.ts'
import { fail, failFromError } from '../core/errors.ts'
import type { IpcResult, MarketCatalog, MarketSourceState } from '../../shared/types.ts'

/**
 * The catalog the renderer was most recently served, keyed so a route switch
 * (or a reload) never answers `market:resolve` with an entry the picker isn't
 * showing. Not a cache that skips fetching — it is only a lookup table for
 * turning a `url` back into its entry. Fetching always happens (loadMarket
 * revalidates); this is purely resolve-side.
 */
let catalog: MarketCatalog | null = null

export function registerMarketIpc(): void {
  ipcMain.handle('market:list', async (_event, opts: { source?: MarketSourceState } = {}) => {
    try {
      const state = opts.source !== undefined
        ? opts.source
        : marketSourceState()
      const data = await loadMarket(state)
      catalog = data
      return { ok: true, value: data }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('market:source', (): IpcResult<MarketSourceState> => {
    try {
      return { ok: true, value: marketSourceState() }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('market:setSource', (_event, next: MarketSourceState): IpcResult<boolean> => {
    try {
      const ok = setMarketSourceState(next)
      // A persisted route change invalidates whatever catalog we held.
      if (ok) catalog = null
      return { ok: true, value: ok }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('market:resolve', async (_event, url: string) => {
    try {
      if (typeof url !== 'string' || url === '') return fail('market.entryNotFound')
      const plugin = catalog?.plugins.find(p => p.url === url) ?? null
      if (plugin === null) return fail('market.entryNotFound')
      return { ok: true, value: { spec: installSpecFor(plugin), plugin } }
    } catch (error) {
      return failFromError(error)
    }
  })
}