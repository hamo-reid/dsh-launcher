/**
 * Archived-version origin tracking. The recorded origins live in their own
 * sidecar file (`<storeDir>/.pm-sources.json`), NOT the store's pnpm manifest —
 * `pnpm add`/`remove` and the legacy migration rewrite that manifest and would
 * silently drop the tracking.
 *
 * Each entry records the origin kind AND (when known) the exact pnpm source spec,
 * so an update check can later resolve a GitHub repo for a github-installed
 * plugin. Older stores hold a bare kind string; both shapes are read.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginSource } from '../../../shared/types.ts'

/** Classify a download source into the store's origin kind. A `github:` spec is a
 * GitHub-source install; `file:` is a locally-added plugin; anything else (a bare
 * name, `name@ver`, `@scope/pk@ver`) is an npm install. */
export function sourceKindOf(source: string): PluginSource {
  const s = source.trim()
  if (s.startsWith('github:')) return 'github'
  if (s.startsWith('file:')) return 'local'
  return 'npm'
}

/** One archived version's origin record. */
interface PluginSourceRecord {
  kind: PluginSource
  /** The exact pnpm source spec (`name@ver`, `github:owner/repo[#path]`, `file:…`). */
  spec?: string
}

/** Path to the origin sidecar. */
function sourcesFile(storeDir: string): string {
  return join(storeDir, '.pm-sources.json')
}

type RawValue = PluginSource | PluginSourceRecord

function readRaw(storeDir: string): Record<string, RawValue> {
  try {
    const v: unknown = JSON.parse(readFileSync(sourcesFile(storeDir), 'utf8'))
    return v !== null && typeof v === 'object' ? (v as Record<string, RawValue>) : {}
  } catch {
    return {}
  }
}

/** Normalize a legacy string value or a current record into a record. */
function normalize(value: RawValue | undefined): PluginSourceRecord | undefined {
  if (typeof value === 'string') return { kind: value }
  if (value !== null && typeof value === 'object' && typeof value.kind === 'string') {
    return { kind: value.kind, ...(typeof value.spec === 'string' && value.spec !== '' ? { spec: value.spec } : {}) }
  }
  return undefined
}

/** Archived-version → origin kind map, keyed `name@version` (legacy-tolerant). */
export function readPluginSources(storeDir: string): Record<string, PluginSource> {
  const out: Record<string, PluginSource> = {}
  for (const [key, value] of Object.entries(readRaw(storeDir))) {
    const rec = normalize(value)
    if (rec !== undefined) out[key] = rec.kind
  }
  return out
}

/** The recorded source spec for a plugin (any archived version), or `undefined`. */
export function readPluginSourceSpec(storeDir: string, name: string): string | undefined {
  const prefix = `${name}@`
  for (const [key, value] of Object.entries(readRaw(storeDir))) {
    if (!key.startsWith(prefix)) continue
    const spec = normalize(value)?.spec
    if (spec !== undefined && spec !== '') return spec
  }
  return undefined
}

/** Record the origin of one archived version. Idempotent per version. */
export function recordPluginSource(
  storeDir: string, name: string, version: string, kind: PluginSource, spec?: string,
): void {
  const data = readRaw(storeDir)
  data[`${name}@${version}`] = spec !== undefined && spec !== '' ? { kind, spec } : { kind }
  writeFileSync(sourcesFile(storeDir), JSON.stringify(data, null, 2) + '\n')
}
