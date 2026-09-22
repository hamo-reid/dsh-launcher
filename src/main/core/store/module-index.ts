/**
 * Module resolution for the dev-plugin diagnosis: which package a patch row's
 * `name:`/`id:` means.
 *
 * A patch row carries either a `name:` (the package it loads) or just an `id:`
 * that ADDRESSES a row some other layer inserted. The id → package map is
 * per-composition and NOT a mechanical prefix: in `@deepseek-ai/dsh-base`'s patch
 * `tool-bash` names `@deepseek-ai/dsh-tool-bash`, but `timer` names
 * `@deepseek-ai/cordis-plugin-timer`. So the map is parsed out of the layers the
 * target actually composes (`buildModuleIndex`), never assembled by string
 * surgery.
 *
 * (Where a name resolves ON DISK — the dev tree, the dsh install, the profile, the
 * shared profiles root, the home — is `module-resolve.ts`, which `combo.ts` shares.)
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { listComboPlugins } from './combo.ts'
import { homePatchPath, profilePatchPath } from '../profile/home.ts'
import { parseNamedRows } from '../patch/patch.ts'
import { createKeyedCache } from '../shared/keyed-cache.ts'
import type { DshContext } from '../profile/appState.ts'
import type { ModuleIndexInfo } from '../../../shared/types.ts'

/** One row feeding the index, in composition order. */
export interface ModuleIndexRow { id: string; name: string; source: string }

/**
 * Fold patch rows into the id → package map. Pure.
 *
 * Only rows that NAME a package create bindings — an id-only row is a lookup,
 * which is exactly the case this exists for. The first layer to name an id wins,
 * mirroring the host, where the earliest `insert:` is what creates the entry; a
 * later layer naming that id differently is a real load failure, reported here as
 * a conflict.
 */
export function buildModuleIndex(rows: readonly ModuleIndexRow[], profile?: string): ModuleIndexInfo {
  const bindings: ModuleIndexInfo['bindings'] = []
  const byId = new Map<string, string>()
  const conflicts = new Map<string, { names: Set<string>; sources: Set<string> }>()
  const layers: ModuleIndexInfo['layers'] = []
  const layerOf = new Map<string, { source: string; rows: number }>()

  for (const row of rows) {
    let layer = layerOf.get(row.source)
    if (layer === undefined) {
      layer = { source: row.source, rows: 0 }
      layerOf.set(row.source, layer)
      layers.push(layer)
    }
    layer.rows += 1

    const name = row.name.trim()
    if (name === '') continue
    const bound = byId.get(row.id)
    if (bound === undefined) {
      byId.set(row.id, name)
      bindings.push({ id: row.id, name, source: row.source })
      continue
    }
    if (bound === name) continue
    const conflict = conflicts.get(row.id) ?? { names: new Set([bound]), sources: new Set<string>() }
    conflict.names.add(name)
    const first = bindings.find(b => b.id === row.id)?.source
    if (first !== undefined) conflict.sources.add(first)
    conflict.sources.add(row.source)
    conflicts.set(row.id, conflict)
  }

  return {
    bindings,
    conflicts: [...conflicts].map(([id, c]) => ({ id, names: [...c.names], sources: [...c.sources] })),
    layers,
    ...(profile !== undefined && profile !== '' ? { profile } : {}),
  }
}

/** One layer's rows from a patch file (`[]` when it is absent or unreadable). */
function rowsOfFile(path: string, source: string): ModuleIndexRow[] {
  if (!existsSync(path)) return []
  try {
    return parseNamedRows(readFileSync(path, 'utf8')).map(row => ({ id: row.id, name: row.name ?? '', source }))
  } catch {
    return []
  }
}

/**
 * The rows that feed the index, in composition order: the target composition
 * (each bundle layer, then the profile's own patch, then the home patch), then the
 * dev package's own patch last — so an id the dev plugin introduces resolves even
 * before it is linked into a profile, while an id a host bundle already names
 * keeps the host's binding (first wins).
 *
 * With no profile the index holds only the non-profile layers (home) plus the dev
 * patch: ids only mean something inside a composition, and unioning every
 * profile's bundles would invent a map no real run uses. The dialog says so.
 */
function collectIndexRows(
  ctx: DshContext,
  profile: string | undefined,
  devPatch: { source: string; rows: readonly { id: string; name?: string }[] },
): ModuleIndexRow[] {
  const rows: ModuleIndexRow[] = []
  if (profile !== undefined && profile !== '') {
    for (const row of listComboPlugins(ctx, profile)) {
      rows.push({ id: row.id, name: row.name, source: row.bundle })
    }
    rows.push(...rowsOfFile(profilePatchPath(ctx, profile), 'profile'))
  }
  rows.push(...rowsOfFile(homePatchPath(ctx), 'home'))
  for (const row of devPatch.rows) rows.push({ id: row.id, name: row.name ?? '', source: devPatch.source })
  return rows
}

// ── cache ───────────────────────────────────────────────────────────────────
//
// Reading every layer's patch is the expensive part of a diagnosis, and the whole
// point of this dialog is to be re-run while editing a patch. So the index is
// keyed on the complete input signature INCLUDING the mtime+size of every layer
// file it read: an edit invalidates it immediately, and the TTL is only a backstop
// for the files it cannot see (a profile re-linked behind our back).

/** Backstop only — mtimes are the real invalidation. */
const CACHE_TTL_MS = 5 * 60_000
/** Distinct (ctx × profile × dev-patch) signatures kept before trimming. */
const MAX_ENTRIES = 8

const indexCache = createKeyedCache<ModuleIndexInfo>({ max: MAX_ENTRIES, ttlMs: CACHE_TTL_MS })

/** The signature of every layer file a build reads (an absent file is stamped as
 * such, so it appearing later is itself a change). */
function indexKey(ctx: DshContext, profile: string | undefined, devPatchFile: string | undefined): string {
  return [
    devPatchFile,
    profile !== undefined && profile !== '' ? profilePatchPath(ctx, profile) : undefined,
    homePatchPath(ctx),
  ].map((file) => {
    if (file === undefined) return '-'
    try {
      const st = statSync(file)
      return `${file}:${st.mtimeMs}:${st.size}`
    } catch {
      return `${file}:-`
    }
  }).concat([ctx.execPath, ctx.home, ctx.version, profile ?? '']).join('\u0000')
}

/**
 * The index for this target, cached. `refresh` bypasses the cache (the dialog's
 * 「重新诊断」), and a changed mtime/size of any layer file misses it.
 */
export function moduleIndexFor(
  ctx: DshContext,
  profile: string | undefined,
  devPatch: { source: string; rows: readonly { id: string; name?: string }[] },
  patchFile: string | undefined,
  refresh = false,
): ModuleIndexInfo {
  const key = indexKey(ctx, profile, patchFile)
  return indexCache.get(
    key,
    () => buildModuleIndex(collectIndexRows(ctx, profile, devPatch), profile),
    { refresh },
  )
}

/** Drop every cached index. Called whenever something changes that resolution
 * depends on but the signature cannot see — a dev plugin's shim junctions being
 * written or removed, the registry itself, or a profile link. */
export function forgetModuleIndex(): void {
  indexCache.forget()
}

/** Look up the package bound to a row id (exact id, then the package's own name). */
export function bindingFor(info: ModuleIndexInfo, id: string): { name: string; source: string } | undefined {
  return info.bindings.find(b => b.id === id)
}
