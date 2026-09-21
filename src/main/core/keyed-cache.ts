/**
 * A keyed cache with the bookkeeping in one place — age, TTL, and the
 * over-budget trim — and the INVALIDATION SEMANTICS left to the caller.
 *
 * That split is the point. Every cache this replaces keys on a full input
 * signature (a layer file's mtime+size, a dev package's shims, the resolved
 * version set), so it invalidates itself the moment its real inputs change and
 * the TTL is only a backstop for what the signature cannot see. The caller
 * therefore builds the key; this module only answers "is the entry still usable"
 * and "which entry goes when we are over budget".
 */

export interface KeyedCacheOptions {
  /** Entries kept before the oldest is dropped. Default: no limit. */
  max?: number
  /** Entry lifetime. Default: `Infinity` — an entry lives until its key changes
   * or `forget` clears it, which is right for a signature-keyed cache. */
  ttlMs?: number
}

export interface KeyedCache<V> {
  /** The entry for `key`, computing and storing it on a miss. `refresh`
   * recomputes even on a hit (the diagnosis dialog's 「重新诊断」). */
  get(key: string, compute: () => V, opts?: { refresh?: boolean }): V
  /** The live entry for `key`, or `undefined`. Never computes, so an async
   * caller can keep its own control flow. */
  peek(key: string): V | undefined
  /** Store a value the caller already has — a revalidated fetch, or a negative
   * result that deserves a shorter life than the default. */
  set(key: string, value: V, opts?: { ttlMs?: number }): void
  /** Drop one entry, or every entry when `key` is omitted. */
  forget(key?: string): void
}

export function createKeyedCache<V>(options: KeyedCacheOptions = {}): KeyedCache<V> {
  const max = options.max ?? Infinity
  const defaultTtl = options.ttlMs ?? Infinity
  const entries = new Map<string, { at: number; ttl: number; value: V }>()

  /** The entry when it is still within its TTL. An expired entry is reported as a
   * miss but left in place: the write that follows replaces it in position. */
  const live = (key: string): V | undefined => {
    const hit = entries.get(key)
    if (hit === undefined) return undefined
    return Date.now() - hit.at < hit.ttl ? hit.value : undefined
  }

  const store = (key: string, value: V, ttl: number): void => {
    // Insertion order, deliberately. A key is a signature, so a changed input is a
    // NEW key — the entry it replaced is stale garbage and should be evicted first,
    // which is exactly what leaving it at its old position achieves. Refreshing the
    // position would keep that garbage alive instead.
    entries.set(key, { at: Date.now(), ttl, value })
    while (entries.size > max) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  return {
    get: (key, compute, opts) => {
      if (opts?.refresh !== true) {
        const hit = live(key)
        if (hit !== undefined) return hit
      }
      const value = compute()
      store(key, value, defaultTtl)
      return value
    },
    peek: (key) => live(key),
    set: (key, value, opts) => { store(key, value, opts?.ttlMs ?? defaultTtl) },
    forget: (key) => {
      if (key === undefined) entries.clear()
      else entries.delete(key)
    },
  }
}
