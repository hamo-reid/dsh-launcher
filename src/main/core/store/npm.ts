/** Query the npm registry: search for plugin candidates + list a package's
 * versions.
 *
 * The two operations resolve against different bases on purpose: a version list
 * is package-scoped and follows the routing (`registryFor`), while a keyword
 * search only ever asks the public catalogue (`SEARCH_REGISTRY`). The
 * raw-normalization functions are exported so the unit tests stay off the wire. */

import type { NpmSearchHit, PackageVersionInfo, RegistryProbe, RegistrySource } from '../../../shared/types.ts'
import { throwE } from '../shared/errors.ts'
import { logger } from '../shared/logger.ts'
import { registryAuthHeader, registryTokenOf } from './registry-auth.ts'
import { PUBLIC_REGISTRY, registryById, registryForSource, SEARCH_REGISTRY } from './registry.ts'

/**
 * Fetch from the configured registry, carrying the credential when the URL
 * belongs to it. One scheme (`Bearer`) because that is what the generated
 * `.npmrc` produces — the lookup in front of an install must authenticate the
 * same way as the install itself.
 */
async function fetchFromRegistry(url: string): Promise<Response> {
  return await fetch(url, { headers: registryAuthHeader(url) })
}

/** Raw shape of one registry search result. */
export interface RawSearchPackage {
  name?: string
  description?: string
  version?: string
  author?: unknown
  date?: string
  keywords?: string[]
}

interface RawSearchResponse {
  objects?: { package?: RawSearchPackage }[]
  total?: number
}

/**
 * Normalize a raw registry search payload into hits + total. Pure — the tests
 * feed it a canned object and assert the field mapping / total.
 */
export function normalizeSearchResults(data: RawSearchResponse): { hits: NpmSearchHit[]; total: number } {
  const hits: NpmSearchHit[] = (data.objects ?? [])
    .map(entry => entry.package)
    .filter((p): p is RawSearchPackage & { name: string } => p !== undefined && typeof p.name === 'string')
    .map(p => {
      const author = typeof p.author === 'string' ? p.author
        : (p.author !== null && typeof p.author === 'object' && typeof (p.author as { name?: unknown }).name === 'string'
          ? (p.author as { name: string }).name
          : undefined)
      return {
        name: p.name,
        description: p.description ?? '',
        version: p.version ?? '',
        ...(author !== undefined ? { author } : {}),
        ...(typeof p.date === 'string' && p.date !== '' ? { date: p.date } : {}),
        ...(Array.isArray(p.keywords) && p.keywords.length > 0 ? { keywords: p.keywords } : {}),
      }
    })
  return { hits, total: typeof data.total === 'number' ? data.total : hits.length }
}

/** Search the npm registry (e.g. text = `dsh` or `@deepseek-ai`). Returns up to
 * `size` hits starting at `from`, plus the registry `total` for pagination. */
export async function npmSearch(
  query: string,
  opts: { size?: number; from?: number } = {},
): Promise<{ hits: NpmSearchHit[]; total: number }> {
  const size = opts.size ?? 25
  const from = opts.from ?? 0
  logger.debug(`npm search: "${query}" (${size})`)
  // The public catalogue, never the configured private source: a registry is a
  // place packages are fetched from by name, and it is under no obligation to
  // answer a keyword. No credential goes with this request — it is a different
  // host, and the token authorizes one registry.
  const url = `${SEARCH_REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=${size}&from=${from}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`npm search failed: HTTP ${res.status}`)
  const data = await res.json() as RawSearchResponse
  const result = normalizeSearchResults(data)
  logger.debug(`npm search: ${result.hits.length}/${result.total} hits for "${query}"`)
  return result
}

/** Fetch the full version list + dist-tags for a package (for the version picker).
 *
 * `source` defaults to `auto`, which is the routing: with a scope configured, a
 * private plugin resolves from the private registry while every other package
 * keeps resolving from the public one. Asking the wrong host here is what makes
 * an install fail later, because pnpm then installs something the user never
 * chose. The download page passes `public` / `private` when the person has said
 * where to look (`registryForSource`). */
export async function fetchPackageVersions(name: string, source: RegistrySource = 'auto'): Promise<PackageVersionInfo> {
  const base = registryForSource(name, source)
  logger.debug(`npm versions: "${name}" @ ${base}`)
  const res = await fetchFromRegistry(`${base}/${encodeURIComponent(name)}`)
  if (!res.ok) throw new Error(`npm 包不存在或不可访问：HTTP ${res.status}`)
  const data = await res.json() as {
    'dist-tags'?: Record<string, string>
    versions?: Record<string, unknown>
  }
  const info = {
    distTags: data['dist-tags'] ?? {},
    versions: Object.keys(data.versions ?? {}),
  }
  logger.debug(`npm versions: "${name}" → ${info.versions.length} available, dist-tags ${Object.keys(info.distTags).join(',') || 'none'}`)
  return info
}

/** Whether a mirror serves a package it does not own — the one thing mirror mode
 * depends on. unknown when the check itself failed: 'could not tell' must not be
 * reported as 'does not proxy'. */
async function probeProxy(registry: string): Promise<'ok' | 'missing' | 'unknown'> {
  try {
    const res = await fetchFromRegistry(registry + '/lodash')
    if (res.ok) return 'ok'
    if (res.status === 404) return 'missing'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export async function probeRegistry(id?: string): Promise<RegistryProbe> {
  // A named entry is what the settings editor tests. Without one this asks the
  // public registry — where every package no scope claims comes from, which is the
  // only "default" left now that a fallback entry no longer exists.
  const entry = id !== undefined ? registryById(id) : undefined
  if (id !== undefined && entry === undefined) throwE('registry.notConfigured')
  const registry = entry?.url ?? PUBLIC_REGISTRY
  const hasToken = entry !== undefined ? registryTokenOf(entry) !== undefined : false
  // Mirror mode makes one claim the warning cannot: that this host proxies npm.
  // Ask it for a package that is definitely public, so the verdict is a fact.
  const proxy = entry?.catchAll === true ? await probeProxy(registry) : undefined
  try {
    const who = await fetchFromRegistry(`${registry}/-/whoami`)
    if (who.ok) {
      const body = await who.json().catch(() => ({})) as { username?: unknown }
      return {
        registry,
        reachable: true,
        auth: 'ok',
        status: who.status,
        ...(proxy !== undefined ? { proxy } : {}),
        ...(typeof body.username === 'string' && body.username !== '' ? { user: body.username } : {}),
      }
    }
    if (who.status === 401 || who.status === 403) {
      // The endpoint exists and refused us: that is a verdict about the token,
      // and whether a token was sent at all decides which one.
      return {
        registry, reachable: true, auth: hasToken ? 'rejected' : 'required', status: who.status,
        ...(proxy !== undefined ? { proxy } : {}),
      }
    }
    const root = await fetchFromRegistry(`${registry}/`)
    return { registry, reachable: true, auth: 'unknown', status: root.status }
  } catch (error) {
    return {
      registry,
      reachable: false,
      auth: 'unknown',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
