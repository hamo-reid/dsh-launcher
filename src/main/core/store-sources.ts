/**
 * Archived-version origin tracking. The recorded origins live in their own
 * sidecar file (`<storeDir>/.pm-sources.json`), NOT the store's pnpm manifest —
 * `pnpm add`/`remove` and the legacy migration rewrite that manifest and would
 * silently drop the tracking.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginSource } from '../../shared/types.ts'

/** Classify a download source into the store's origin kind. A `github:` spec is a
 * GitHub-source install; `file:` is a locally-added plugin; anything else (a bare
 * name, `name@ver`, `@scope/pk@ver`) is an npm install. */
export function sourceKindOf(source: string): PluginSource {
  const s = source.trim()
  if (s.startsWith('github:')) return 'github'
  if (s.startsWith('file:')) return 'local'
  return 'npm'
}

/** Path to the origin sidecar. */
export function sourcesFile(storeDir: string): string {
  return join(storeDir, '.pm-sources.json')
}

/** Archived-version → origin map, keyed `name@version`. */
export function readPluginSources(storeDir: string): Record<string, PluginSource> {
  try {
    const v: unknown = JSON.parse(readFileSync(sourcesFile(storeDir), 'utf8'))
    return v !== null && typeof v === 'object' ? (v as Record<string, PluginSource>) : {}
  } catch {
    return {}
  }
}

/** Record the origin of one archived version. Idempotent per version. */
export function recordPluginSource(storeDir: string, name: string, version: string, kind: PluginSource): void {
  const data = readPluginSources(storeDir)
  data[`${name}@${version}`] = kind
  writeFileSync(sourcesFile(storeDir), JSON.stringify(data, null, 2) + '\n')
}