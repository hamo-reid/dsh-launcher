/** IPC for the community market (`market:*`): catalog fetch, loading-route
 * picker, and install-target resolution. Business logic lives in market.ts;
 * this file only wires the channels and reports failures the launcher way. */

import { handle } from './handle.ts'
import { installSpecFor, marketSourceState, pageCatalog, resolveMarket, setMarketSourceState } from '../core/market.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import type { IpcResult, MarketCatalog, MarketListOpts, MarketPage, MarketSourceState } from '../../shared/types.ts'

/**
 * The catalog the renderer was most recently served, keyed so a route switch
 * (or a reload) never answers `market:resolve` with an entry the picker isn't
 * showing. Not a cache that skips fetching — it is only a lookup table for
 * turning a `url` back into its entry. Fetching always happens (loadMarket
 * revalidates); this is purely resolve-side.
 */
let catalog: MarketCatalog | null = null

export function registerMarketIpc(): void {
  handle('market:list', async (_event, opts: MarketListOpts = {}): Promise<IpcResult<MarketPage>> => {
    try {
      const state = opts.source !== undefined
        ? opts.source
        : marketSourceState()
      // Memoized-catalog fast path: no network unless refresh forces one or the
      // route changed. Filter + slice happen locally, so paging/search/sort are
      // instant; the renderer only ever holds a bounded slice + total.
      const data = await resolveMarket(state, opts.refresh === true)
      catalog = data
      return { ok: true, value: pageCatalog(data, opts) }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('market:source', (): IpcResult<MarketSourceState> => {
    try {
      return { ok: true, value: marketSourceState() }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('market:setSource', (_event, next: MarketSourceState): IpcResult<boolean> => {
    try {
      const ok = setMarketSourceState(next)
      // A persisted route change invalidates whatever catalog we held.
      if (ok) catalog = null
      return { ok: true, value: ok }
    } catch (error) {
      return failFromError(error)
    }
  })

  handle('market:resolve', async (_event, url: string) => {
    try {
      if (typeof url !== 'string' || url === '') return fail(E.marketEntryNotFound)
      const plugin = catalog?.plugins.find(p => p.url === url) ?? null
      if (plugin === null) return fail(E.marketEntryNotFound)
      return { ok: true, value: { spec: installSpecFor(plugin), plugin } }
    } catch (error) {
      return failFromError(error)
    }
  })
}