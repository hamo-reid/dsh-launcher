/**
 * App-level settings persistence — SQLite (via sql.js, WASM, zero native deps).
 *
 * Enterprise-shaped persistence:
 * - **In-memory singleton.** The DB is read once at {@link openDatabase} into
 *   `current`; {@link loadSettings} returns a clone with no DB round-trip.
 * - **Single write entry.** {@link updateSettings}/{@link patchSettings} do an
 *   atomic read-modify-write, so two callers can never clobber each other's
 *   fields. {@link saveSettings} is a write-through full replace (legacy import
 *   and tests only).
 * - **Schema version + migrations.** `meta.schemaVersion` drives an ordered
 *   migration runner; a newer-than-us build never downgrades the version.
 * - **Split rows.** Settings live in three independent rows (`prefs`, `dsh`,
 *   `launch`) plus `meta`, so one change rewrites one row, not the whole blob.
 *   A legacy single `app` row is split on first open and kept as a backup.
 * - **Corruption self-heal.** A row that fails to parse is archived to a sidecar
 *   and treated as absent. A whole file that cannot be opened falls back to
 *   `app.sqlite.bak` (mirrored after every successful flush), then to empty.
 * - **Crash-safe, coalesced flush.** Rows are updated in memory immediately and
 *   exported to disk once per tick (deduped when nothing changed); the export is
 *   fsync'd then atomically renamed over `app.sqlite`.
 *
 * The pure shape/coercion layer is `settings-normalize.ts` and the on-disk file
 * choreography is `settings-file.ts`; the six module-level bindings below are the
 * only mutable state across the three, and they stay in this one place.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import { logger } from './logger.ts'
import {
  CURRENT_SCHEMA_VERSION, isRecord, normalizeSettings, runMigrations, splitDsh, splitLaunch, splitPrefs,
} from './settings-normalize.ts'
import { archiveFile, flushToDisk, pruneArchives, snapshotBackup } from './settings-file.ts'
import type { AppSettings, DshSettings, LaunchSettings, PrefsSettings } from './settings-normalize.ts'

// Kept on this module's public surface so importers of `./settings.ts` are unchanged.
export { CURRENT_SCHEMA_VERSION, normalizeSettings } from './settings-normalize.ts'
export type { AppSettings } from './settings-normalize.ts'

/** Row keys in `app_settings`. `legacy` is the pre-split single-row blob. */
const ROW = { prefs: 'prefs', dsh: 'dsh', launch: 'launch', meta: 'meta', legacy: 'app' } as const

const require = createRequire(import.meta.url)

let db: Database | null = null
let dbFile = ''
/** The parsed settings, the single source of truth for reads/writes. */
let current: AppSettings = {}
let schemaVersion = CURRENT_SCHEMA_VERSION
/** Last flushed row signature — skips a redundant export when nothing changed. */
let lastSignature = ''
/** A flush is scheduled but not yet run (same-tick coalescing). */
let pending = false

function ensureDb(): Database {
  if (db === null) throw new Error('settings database is not open')
  return db
}

// ── open / load ──────────────────────────────────────────────────────────────

/** Open the settings database, loading it into memory and migrating it in place.
 * Falls back to `<file>.bak` (then to empty) when the primary file is unusable. */
export async function openDatabase(dbPath: string): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: (name) => require.resolve(`sql.js/dist/${name}`),
  })
  dbFile = dbPath
  // New session: forget any coalescing state left by a previous open.
  lastSignature = ''
  pending = false

  const loaded = loadWithFallback(SQL, dbPath)
  db = loaded.db
  db.run('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)')

  importLegacyJson()
  const raw = readMergedRaw()
  const migrated = runMigrations(normalizeSettings(raw.data), raw.version)
  current = migrated.data
  // Never downgrade: an older build must not stamp its version over a newer DB.
  schemaVersion = Math.max(migrated.version, raw.version)
  // Land the split layout + version once (idempotent; also migrates a legacy row).
  if (!raw.split || raw.version !== schemaVersion || loaded.recovered) {
    persist()
    flushSettings()
  }
  // Mirror the good state so a future file-level corruption can recover it.
  snapshotBackup(dbFile)
  pruneArchives(dbFile)
  logger.info(`settings db opened: ${dbPath} (schema v${schemaVersion}${loaded.recovered ? ', recovered from backup' : ''})`)
}

type LoadAttempt = { db: Database; error?: undefined } | { db?: undefined; error: 'missing' | 'empty' | 'unreadable' }

/** Load one DB file, validating that the settings table is queryable. */
function tryLoad(SQL: SqlJsStatic, path: string): LoadAttempt {
  if (!existsSync(path)) return { error: 'missing' }
  try {
    const bytes = new Uint8Array(readFileSync(path))
    if (bytes.length === 0) return { error: 'empty' }
    const candidate = new SQL.Database(bytes)
    candidate.exec('SELECT COUNT(*) FROM app_settings')
    return { db: candidate }
  } catch (error) {
    logger.warn(`settings: cannot open ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return { error: 'unreadable' }
  }
}

/** Primary → backup → empty, archiving any genuinely unreadable file. */
function loadWithFallback(SQL: SqlJsStatic, path: string): { db: Database; recovered: boolean } {
  const primary = tryLoad(SQL, path)
  if (primary.db !== undefined) return { db: primary.db, recovered: false }
  if (primary.error === 'unreadable') archiveFile(path)

  const backup = tryLoad(SQL, `${path}.bak`)
  if (backup.db !== undefined) {
    logger.warn(`settings: recovered from backup (${primary.error})`)
    return { db: backup.db, recovered: true }
  }
  if (backup.error === 'unreadable') archiveFile(`${path}.bak`)
  if (primary.error === 'unreadable' || backup.error === 'unreadable') {
    logger.error('settings: primary and backup unusable; starting empty')
  }
  return { db: new SQL.Database(), recovered: primary.error === 'unreadable' || backup.error === 'unreadable' }
}

/** One-time import from the pre-SQLite `settings.json` when the DB is empty. */
function importLegacyJson(): void {
  const legacy = join(dirname(dbFile), 'settings.json')
  if (!existsSync(legacy)) return
  if (countRows() > 0) return
  try {
    const parsed = normalizeSettings(JSON.parse(readFileSync(legacy, 'utf8')) as unknown)
    if (Object.keys(parsed).length > 0) {
      current = parsed
      schemaVersion = CURRENT_SCHEMA_VERSION
      persist()
      flushSettings()
      renameSync(legacy, `${legacy}.bak`)
      logger.info('settings: imported legacy settings.json')
    }
  } catch {
    // Leave the legacy file untouched on any parse/export failure.
  }
}

/** Read + merge the split rows, falling back to the legacy single-row blob. */
function readMergedRaw(): { data: AppSettings; version: number; split: boolean } {
  const prefs = readJson<PrefsSettings>(ROW.prefs)
  const dsh = readJson<DshSettings>(ROW.dsh)
  const launch = readJson<LaunchSettings>(ROW.launch)
  const meta = readJson<{ schemaVersion?: number }>(ROW.meta)
  const split = prefs !== undefined || dsh !== undefined || launch !== undefined
  if (split) {
    return {
      data: { ...(prefs ?? {}), ...(dsh ?? {}), ...(launch ?? {}) },
      version: typeof meta?.schemaVersion === 'number' ? meta.schemaVersion : 0,
      split: true,
    }
  }
  const legacy = readJson<AppSettings>(ROW.legacy)
  return { data: legacy ?? {}, version: 0, split: false }
}

function readJson<T>(key: string): T | undefined {
  const raw = readValue(key)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    archiveCorrupt(key, raw)
    return undefined
  }
}

function readValue(key: string): string | undefined {
  const result = ensureDb().exec('SELECT value FROM app_settings WHERE key = ?', [key])
  const value = result[0]?.values[0]?.[0]
  return value === undefined ? undefined : String(value)
}

function countRows(): number {
  const result = ensureDb().exec('SELECT COUNT(*) FROM app_settings')
  return Number(result[0]?.values[0]?.[0] ?? 0)
}

/** Archive an unparseable row to a sidecar so it is never silently destroyed. */
function archiveCorrupt(key: string, raw: string): void {
  try {
    const path = `${dbFile}.corrupt-${key}-${Date.now()}.json`
    writeFileSync(path, raw)
    logger.error(`settings row '${key}' was corrupt; archived to ${path}`)
  } catch (error) {
    logger.error(`settings row '${key}' was corrupt and could not be archived`, error)
  }
}

/** Load app settings — an in-memory clone; missing/corrupt rows are absent. */
export function loadSettings(): AppSettings {
  try {
    return structuredClone(current)
  } catch {
    return {}
  }
}

// ── write ────────────────────────────────────────────────────────────────────

/** Atomically read-modify-write the settings. `mutate` receives a draft and may
 * either mutate it or return a replacement; the result is normalized and
 * flushed (coalesced within the tick). This is the ONLY safe write path. */
export function updateSettings(mutate: (draft: AppSettings) => AppSettings | void): AppSettings {
  const draft = structuredClone(current)
  const next = mutate(draft) ?? draft
  current = normalizeSettings(next)
  persist()
  return loadSettings()
}

/** Shallow-merge `partial` into the settings (read-modify-write). */
export function patchSettings(partial: Partial<AppSettings>): AppSettings {
  return updateSettings((draft) => { Object.assign(draft, partial) })
}

/** Full replace, written through to disk. Prefer {@link updateSettings} /
 * {@link patchSettings}; retained for the legacy import and tests. */
export function saveSettings(settings: AppSettings): void {
  current = normalizeSettings(settings)
  persist()
  flushSettings()
}

/** Drop a single top-level key (used by directory resets). */
export function clearSetting(key: keyof AppSettings): AppSettings {
  return updateSettings((draft) => { delete draft[key] })
}

/** Update the in-memory rows and schedule a coalesced flush (skip when the rows
 * are byte-identical to the last flush — a cheap no-op dedupe). */
function persist(): void {
  const rows = {
    [ROW.prefs]: splitPrefs(current),
    [ROW.dsh]: splitDsh(current),
    [ROW.launch]: splitLaunch(current),
    [ROW.meta]: { schemaVersion },
  }
  const signature = JSON.stringify(rows)
  if (signature === lastSignature) return
  lastSignature = signature
  const dbi = ensureDb()
  dbi.run('BEGIN')
  try {
    for (const [key, value] of Object.entries(rows)) writeRow(key, value)
    dbi.run('COMMIT')
  } catch (error) {
    try { dbi.run('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
  if (!pending) {
    pending = true
    queueMicrotask(() => {
      if (!pending) return // already flushed (e.g. by flushSettings) — don't re-write
      pending = false
      flushNow()
    })
  }
}

function writeRow(key: string, value: unknown): void {
  ensureDb().run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(value)],
  )
}

function flushNow(): void {
  flushToDisk(ensureDb(), dbFile)
  snapshotBackup(dbFile)
}

/** Force any coalesced write to disk now (lifecycle boundaries, tests). */
export function flushSettings(): void {
  pending = false
  flushToDisk(ensureDb(), dbFile)
  snapshotBackup(dbFile)
}

/** Export the settings plus a header, for backup / migration. The GitHub token
 * and the MCP launch secrets are secrets and are deliberately left out. */
export function exportSettings(): string {
  const app = loadSettings()
  delete app.githubTokenEnc
  delete app.mcpSecrets
  return JSON.stringify(
    { schemaVersion, exportedAt: new Date().toISOString(), app },
    null, 2,
  )
}

/** Import a settings export (or a bare `AppSettings` object). Refuses an export
 * written by a newer schema so an older build never corrupts it. */
export function importSettings(json: string): void {
  const parsed = JSON.parse(json) as unknown
  const envelope = isRecord(parsed) && isRecord(parsed.app) ? parsed : { app: parsed }
  const fromVersion = typeof envelope.schemaVersion === 'number' ? envelope.schemaVersion : 0
  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`settings export is newer (v${fromVersion}) than this app (v${CURRENT_SCHEMA_VERSION})`)
  }
  const migrated = runMigrations(normalizeSettings(envelope.app), fromVersion).data
  // An export never carries secrets; keep the ones already on this machine.
  const existingToken = current.githubTokenEnc
  const existingSecrets = current.mcpSecrets
  current = existingToken !== undefined ? { ...migrated, githubTokenEnc: existingToken } : migrated
  current = existingSecrets !== undefined ? { ...current, mcpSecrets: existingSecrets } : current
  schemaVersion = CURRENT_SCHEMA_VERSION
  lastSignature = ''
  persist()
  flushSettings()
}

// ── split / normalize ────────────────────────────────────────────────────────

// ── derived accessors ────────────────────────────────────────────────────────

/** Whether closing the window should minimize to tray rather than quit.
 * Absent / unspecified → tray (the default close behaviour). */
export function closeToTrayEnabled(): boolean {
  return loadSettings().closeToTray !== false
}

/** Whether closing the window should ask the user each time. Absent / unset →
 * ask (the default, until the user picks "don't ask again"). */
export function askOnCloseEnabled(): boolean {
  return loadSettings().askOnClose !== false
}

/** The user's preferred node for launching dsh (`'system'` when unset). */
export function nodePreferenceValue(): 'system' | 'bundled' {
  const p = loadSettings().nodePreference
  return p === 'bundled' ? 'bundled' : 'system'
}
