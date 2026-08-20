/**
 * Home data archival & restore — the file-level backbone shared by the DSH
 * version-update backup, the DSH data export/import, and the cross-version
 * data mirror.
 *
 * Scope boundary (by design): the Launcher migrates *files* under `$DSH_HOME`,
 * NOT the dsh storage layers' internal schema. Each data layer (session log
 * format, storage-domain `version`, sqlite SCHEMA_VERSION) is version-gated by
 * dsh itself with a reject-on-mismatch policy; the Launcher copies the file set
 * verbatim and surfaces a cross-major warning, letting dsh's own gates be the
 * authority on format compatibility. It never rewrites a sessions/storages file.
 *
 * The migratable set is the dsh home layout confirmed against the source
 * harness repo: session logs, KV storages, content-addressed attachments, and
 * the plain user-config files/skill/preset roots; home-level `cordis.patch.yml`
 * included. Everything dsh rebuilds or is transient — `node_modules`,
 * each profile's boot-rewritten `cordis.yml`, projection caches, sqlite
 * indexes, spill/sandbox temps — is excluded.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import AdmZip from 'adm-zip'
import { parseVersion } from './version.ts'
import type { DshContext } from './appState.ts'
import type { DshDataManifest, DshDataImportResult } from '../../shared/types.ts'

/** Top-level home entries that carry user data and migrate with the user. */
export const MIGRATABLE_TOP_LEVEL: string[] = [
  'sessions',
  'storages',
  'attachments',
  '.credentials.yaml',
  'settings.yaml',
  '.env',
  'AGENTS.md',
  'skills',
  '.agent-presets',
  'cordis.patch.yml',
]

/** Inside one profile directory, the files that carry user config and migrate.
 * `node_modules` and the boot-rewritten `cordis.yml` are deliberately absent. */
const PROFILE_MIGRATABLE = ['package.json', 'cordis.patch.yml']

/** Top-level home entries never migrated (rebuilt / derived). */
const NON_MIGRATABLE_TOP_LEVEL = new Set(['node_modules'])

/** Which migratable top-level entries actually exist under `home`. */
export function listMigratableHomeData(home: string): string[] {
  return MIGRATABLE_TOP_LEVEL.filter(entry => existsSync(join(home, entry)))
}

/** Copy a single file or directory into `dest`, backing up any existing file at
 * `dest` to `dest + '.bak'` first (directories merge recursively). */
function copyInto(src: string, dest: string): void {
  const destDir = dirname(dest)
  if (existsSync(src) && statSync(src).isDirectory()) {
    mkdirSync(destDir, { recursive: true })
    cpSync(src, dest, { recursive: true })
    return
  }
  if (existsSync(dest)) renameSync(dest, `${dest}.bak`)
  mkdirSync(destDir, { recursive: true })
  cpSync(src, dest)
}

/** Copy every migratable entry (home-level + per-profile minimal) from
 * `sourceHome` into the sink rooted at `sinkRoot`. Handles both a clean archive
 * target (nothing to back up) and an existing target (`.bak`-backs up files). */
function copyMigratable(sourceHome: string, sinkRoot: string): void {
  for (const entry of MIGRATABLE_TOP_LEVEL) {
    const src = join(sourceHome, entry)
    if (!existsSync(src)) continue
    copyInto(src, join(sinkRoot, entry))
  }
  // Per-profile minimal: package.json + cordis.patch.yml only. Skipping the
  // pnpm-managed node_modules, boot-rewritten cordis.yml, and pnpm lock trees.
  const srcProfiles = join(sourceHome, 'profiles')
  if (!existsSync(srcProfiles)) return
  for (const dirent of readdirSync(srcProfiles, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    if (NON_MIGRATABLE_TOP_LEVEL.has(dirent.name)) continue
    const srcDir = join(srcProfiles, dirent.name)
    for (const file of PROFILE_MIGRATABLE) {
      const srcFile = join(srcDir, file)
      if (!existsSync(srcFile)) continue
      copyInto(srcFile, join(sinkRoot, 'profiles', dirent.name, file))
    }
  }
}

/** Archive the migratable data of `home` into a fresh `destDir` (the update
 * backup / export sink). The destination is treated as empty. */
export function archiveHome(home: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true })
  copyMigratable(home, destDir)
}

/** Restore the migratable data of an archived `srcDir` into `home`. Existing
 * files are `.bak`-backed up up front, so a re-run never silently clobbers the
 * current state. */
export function restoreHome(srcDir: string, home: string): void {
  mkdirSync(home, { recursive: true })
  copyMigratable(srcDir, home)
}

/** Directly migrate the migratable data between two installed dsh homes (the
 * cross-version mirror path) without a zip round-trip. Same `.bak` semantics as
 * {@link restoreHome}. */
export function copyDshHome(sourceHome: string, targetHome: string): void {
  mkdirSync(targetHome, { recursive: true })
  copyMigratable(sourceHome, targetHome)
}

// ── DSH data archive (zip) export / import / mirror ─────────────────────────

/** Best-effort probe of each KV-storage domain's declared `version`, for the
 * archive manifest. Informational only — the Launcher never interprets them. */
function probeStorageVersions(home: string): Record<string, number> {
  const out: Record<string, number> = {}
  const dir = join(home, 'storages')
  if (!existsSync(dir)) return out
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'number') out[file] = parsed.version
    } catch { /* skip unreadable */ }
  }
  return out
}

/** Recursively add a tree into a zip at `zipRoot` (no leading slash). */
function addTree(zip: AdmZip, base: string, zipRoot = ''): void {
  for (const dirent of readdirSync(base, { withFileTypes: true })) {
    const full = join(base, dirent.name)
    const rel = zipRoot === '' ? dirent.name : `${zipRoot}/${dirent.name}`
    if (dirent.isDirectory()) addTree(zip, full, rel)
    else zip.addFile(rel, readFileSync(full))
  }
}

/** Read the `data-manifest.json` from an extracted archive dir, or `null`. */
function readDataManifest(dir: string): DshDataManifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'data-manifest.json'), 'utf8')) as DshDataManifest
  } catch {
    return null
  }
}

const majorOf = (v: string): number => parseVersion(v)?.major ?? -1

/** Export a dsh's migratable data (home-level + per-profile minimal) into a zip
 * at `destFile`, tagged with a `data-manifest.json`. `ctx` supplies the home and
 * the dsh version the data came from. Returns the written manifest. */
export function exportDshData(ctx: DshContext, destFile: string): DshDataManifest {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-data-export-'))
  try {
    archiveHome(ctx.home, tmp)
    const arc = new AdmZip()
    addTree(arc, tmp)
    const manifest: DshDataManifest = {
      schemaVersion: 1,
      dshVersion: ctx.version,
      exportedAt: new Date().toISOString(),
      storageVersions: probeStorageVersions(ctx.home),
    }
    arc.addFile('data-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
    writeFileSync(destFile, arc.toBuffer())
    return manifest
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Import a DSH data archive into `ctx`'s home. Cross-major is refused unless
 * `forceDsh`. Restores home-level data + per-profile minimal config (files only;
 * bundles/plugins are resolved by dsh on its next boot). */
export function importDshData(
  ctx: DshContext, srcFile: string, opts: { forceDsh?: boolean } = {},
): DshDataImportResult {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-data-import-'))
  try {
    new AdmZip(srcFile).extractAllTo(tmp, true)
    const manifest = readDataManifest(tmp)
    const want = manifest?.dshVersion ?? ''
    if (want !== '' && majorOf(want) !== majorOf(ctx.version) && opts.forceDsh !== true) {
      return { ok: false, text: `该数据导出自 dsh ${want}，当前为 ${ctx.version}，major 不匹配。`, dshMismatch: true }
    }
    restoreHome(tmp, ctx.home)
    return { ok: true, text: '已恢复 DSH 数据', dshMismatch: false }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Mirror a source dsh's data into a target dsh's home directly (no zip). The
 * IPC layer gates the cross-major confirmation before calling. */
export function mirrorDshData(source: DshContext, target: DshContext): DshDataImportResult {
  copyDshHome(source.home, target.home)
  return { ok: true, text: '已迁移 DSH 数据', dshMismatch: false }
}