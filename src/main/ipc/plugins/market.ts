/** IPC for the community market (`market:*`): catalog fetch, loading-route
 * picker, and install-target resolution. Business logic lives in market.ts;
 * this file only wires the channels and reports failures the launcher way. */

import { handle } from '../handle.ts'
import {
  annotationsFor, installSpecFor, marketSourceState, pageCatalog, resolveMarket, setMarketSourceState,
} from '../../core/store/market.ts'
import { fail, failFromError, E } from '../../core/shared/errors.ts'
import type {
  IpcResult, MarketAnnotations, MarketCatalog, MarketListOpts, MarketPage, MarketSourceState,
} from '../../../shared/types.ts'

/**
 * The catalog the renderer was most recently served, keyed so a route switch
 * (or a reload) never answers `market:resolve` with an entry the picker isn't
 * showing. Not a cache that skips fetching — it is only a lookup table for
 * turning a `url` back into its entry. Fetching always happens (loadMarket
 * revalidates); this is purely resolve-side.
 */
let catalog: MarketCatalog | null = null

/** Annotation result cache — success is held long, a failure only briefly, so an
 * unreachable market never stalls every plugin-page entry. */
let annotationsCache: { at: number; ttl: number; value: MarketAnnotations } | null = null
const ANNOTATIONS_OK_TTL_MS = 10 * 60_000
const ANNOTATIONS_FAIL_TTL_MS = 60_000

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
      if (ok) { catalog = null; annotationsCache = null }
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

  // Category / deprecation annotations for the installed-plugin overview. Served
  // from the memoized catalog when warm; a first call loads (and caches) it. A
  // load failure degrades to empty annotations — the overview must never depend
  // on the market being reachable.
  handle('market:annotations', async (): Promise<IpcResult<MarketAnnotations>> => {
    if (annotationsCache !== null && Date.now() - annotationsCache.at < annotationsCache.ttl) {
      return { ok: true, value: annotationsCache.value }
    }
    try {
      const data = await resolveMarket(marketSourceState())
      catalog = data
      const value = annotationsFor(data)
      annotationsCache = { at: Date.now(), ttl: ANNOTATIONS_OK_TTL_MS, value }
      return { ok: true, value }
    } catch {
      const value: MarketAnnotations = { categories: {}, plugins: {} }
      annotationsCache = { at: Date.now(), ttl: ANNOTATIONS_FAIL_TTL_MS, value }
      return { ok: true, value }
    }
  })
}