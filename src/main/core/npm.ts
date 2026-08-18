/** Query the npm registry: search for plugin candidates + list a package's
 * versions. The raw-normalization functions are exported for unit tests so the
 * HTTP calls stay out of the test path. */

import type { NpmSearchHit, PackageVersionInfo } from '../../shared/types.ts'

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
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${size}&from=${from}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`npm search failed: HTTP ${res.status}`)
  const data = await res.json() as RawSearchResponse
  return normalizeSearchResults(data)
}

/** Fetch the full version list + dist-tags for a package (for the version picker). */
export async function fetchPackageVersions(name: string): Promise<PackageVersionInfo> {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
  if (!res.ok) throw new Error(`npm 包不存在或不可访问：HTTP ${res.status}`)
  const data = await res.json() as {
    'dist-tags'?: Record<string, string>
    versions?: Record<string, unknown>
  }
  return {
    distTags: data['dist-tags'] ?? {},
    versions: Object.keys(data.versions ?? {}),
  }
}