/**
 * The soft-delete trash: `<profilesDir>/.trash`. Soft-deleted profiles land
 * here (see `softDeleteProfile`); this module lists them and provides the
 * recovery / permanent-delete / empty operations.
 *
 * Only the active dsh's trash is touched — it lives under its own `profilesDir`.
 */
import { existsSync, readdirSync, readFileSync, rmSync, renameSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { profilesDir } from './home.ts'
import { parsePatchRows } from './patch.ts'
import type { TrashItem } from '../../shared/types.ts'

/** The trash root for the active dsh. */
export function trashDir(): string {
  return join(profilesDir(), '.trash')
}

/** Recursively sum the byte size of a directory tree. */
function dirSize(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else {
      try { total += statSync(full).size } catch { /* raced/removed → skip */ }
    }
  }
  return total
}

interface ManifestShape {
  dsh?: { profile?: { bundles?: string[] } }
  dependencies?: Record<string, string>
}

/** One soft-deleted profile's on-disk directory. */
function trashItemDir(name: string): string {
  return join(trashDir(), name)
}

/** List every soft-deleted profile in the trash, newest-deleted first. */
export function listTrashItems(): TrashItem[] {
  const dir = trashDir()
  if (!existsSync(dir)) return []
  const items: TrashItem[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    const manifestPath = join(full, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest: ManifestShape = {}
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestShape
    } catch {
      continue
    }
    let patchRows = 0
    const patchPath = join(full, 'cordis.patch.yml')
    if (existsSync(patchPath)) {
      try { patchRows = parsePatchRows(readFileSync(patchPath, 'utf8')).length } catch { /* ignore */ }
    }
    let deletedAt: string
    try {
      deletedAt = statSync(full).mtime.toISOString()
    } catch {
      deletedAt = ''
    }
    items.push({
      name: entry.name,
      bundles: manifest.dsh?.profile?.bundles ?? [],
      deps: Object.keys(manifest.dependencies ?? {}),
      patchRows,
      sizeBytes: dirSize(full),
      deletedAt,
    })
  }
  return items.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0))
}

/** The base profile name, stripping any ` (n)` suffix the trash assigned when a
 * colliding delete landed next to a same-named entry. Profile names are always
 * kebab-case, so a ` (\d+)` suffix can only have come from `uniqueTrashName`. */
function baseTrashName(name: string): string {
  return name.replace(/ \(\d+\)$/, '')
}

/** Reserve a non-colliding trash name for a delete: `name` when free, else
 * `name (2)`, `name (3)`, … — so a delete always succeeds even when the trash
 * already holds a same-named profile. Throws only on pathological exhaustion. */
export function uniqueTrashName(name: string): string {
  if (!existsSync(trashItemDir(name))) return name
  for (let i = 2; i <= 10000; i++) {
    const candidate = `${name} (${i})`
    if (!existsSync(trashItemDir(candidate))) return candidate
  }
  throw new Error(`回收站中同名项过多，无法为「${name}」分配编号。`)
}

/** Restore a soft-deleted profile back to `<profilesDir>/<baseName>` (a
 * ` (n)`-suffixed trash entry is returned to its original kebab name so no
 * numbered folder leaks into the active list). Refuses when the base name is
 * already taken there (never overwrites). */
export function restoreTrashItem(name: string): void {
  const src = trashItemDir(name)
  if (!existsSync(src)) throw new Error(`回收站中没有「${name}」`)
  const base = baseTrashName(name)
  const dst = join(profilesDir(), base)
  if (existsSync(dst)) throw new Error(`已有同名 profile「${base}」，请先处理再恢复。`)
  renameSync(src, dst)
  // Keep a consistent mtime after restore (a rotate/imported marker, not needed,
  // but avoids any confusion from the trash-stamp carried over).
  const now = new Date()
  utimesSync(dst, now, now)
}

/** Permanently delete one soft-deleted profile from the trash. */
export function deleteTrashItem(name: string): void {
  rmSync(trashItemDir(name), { recursive: true, force: true })
}

/** Permanently delete every entry in the trash; keeps the `.trash` dir itself.
 * Returns how many entries were removed. */
export function emptyTrash(): number {
  const dir = trashDir()
  if (!existsSync(dir)) return 0
  const names = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.name !== '.' && entry.name !== '..')
    .map(entry => entry.name)
  for (const name of names) rmSync(join(dir, name), { recursive: true, force: true })
  return names.length
}