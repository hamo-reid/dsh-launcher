/** Query the npm registry: search for plugin candidates + list a package's
 * versions. The base URL comes from the configured registry (`store/registry.ts`)
 * so the launcher's own lookups and the packages pnpm later installs come from
 * one place. The raw-normalization functions are exported for unit tests so the
 * HTTP calls stay out of the test path. */

import type { NpmSearchHit, PackageVersionInfo, RegistryProbe } from '../../../shared/types.ts'
import { logger } from '../shared/logger.ts'
import { registryAuthCandidates, registryToken } from './registry-auth.ts'
import { registryBase, registryFor, registryForSearch } from './registry.ts'

/**
 * Fetch from a registry, carrying the credential when the URL belongs to the
 * configured private one.
 *
 * The candidates are tried in order on 401/403: `Bearer` is what pnpm sends for
 * an `_authToken`, so it is what a registry behind that file expects; `Basic`
 * covers the registries that authenticate with a user name instead. The point of
 * the fallback is that the lookup in front of an install must not fail where the
 * install itself would have succeeded.
 */
async function fetchFromRegistry(url: string): Promise<Response> {
  const [first, ...rest] = registryAuthCandidates(url)
  let res = await fetch(url, { headers: first ?? {} })
  for (const headers of rest) {
    if (res.status !== 401 && res.status !== 403) return res
    res = await fetch(url, { headers })
  }
  return res
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
  const base = registryForSearch()
  const url = `${base}/-/v1/search?text=${encodeURIComponent(query)}&size=${size}&from=${from}`
  // Search has no package name to route by, so it follows the broad half of the
  // routing (see `registryForSearch`). It carries the credential only when that
  // IS the private registry.
  const res = await fetchFromRegistry(url)
  if (!res.ok) throw new Error(`npm search failed: HTTP ${res.status}`)
  const data = await res.json() as RawSearchResponse
  const result = normalizeSearchResults(data)
  logger.debug(`npm search: ${result.hits.length}/${result.total} hits for "${query}"`)
  return result
}

/** Fetch the full version list + dist-tags for a package (for the version picker).
 *
 * The registry is chosen per package (`registryFor`), not globally: with a scope
 * configured, a private plugin resolves from the private registry while every
 * other package keeps resolving from the public one. Asking the wrong host here
 * is what makes an install fail later, because pnpm then installs something the
 * user never chose. */
export async function fetchPackageVersions(name: string): Promise<PackageVersionInfo> {
  const base = registryFor(name)
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

/**
 * Reach the configured registry and report what the credential did.
 *
 * The endpoint is `/-/whoami`, not the registry root: a registry's root is not a
 * package and answers 404 on a perfectly healthy source, so probing it can only
 * ever prove "some host answered". `/-/whoami` needs no package name and answers
 * with the authenticated user, which is the thing the person who just pasted a
 * token actually wants to know.
 *
 * A source without that endpoint falls back to the root: `auth: 'unknown'` says
 * the host answers and the credential went unchecked, rather than inventing a
 * verdict. Nothing is thrown — a wrong address is a result, not an exception.
 */
export async function probeRegistry(): Promise<RegistryProbe> {
  const registry = registryBase()
  const hasToken = registryToken() !== undefined
  try {
    const who = await fetchFromRegistry(`${registry}/-/whoami`)
    if (who.ok) {
      const body = await who.json().catch(() => ({})) as { username?: unknown }
      return {
        registry,
        reachable: true,
        auth: 'ok',
        status: who.status,
        ...(typeof body.username === 'string' && body.username !== '' ? { user: body.username } : {}),
      }
    }
    if (who.status === 401 || who.status === 403) {
      // The endpoint exists and refused us: that is a verdict about the token,
      // and whether a token was sent at all decides which one.
      return { registry, reachable: true, auth: hasToken ? 'rejected' : 'required', status: who.status }
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