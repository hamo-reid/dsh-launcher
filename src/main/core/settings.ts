/**
 * App-level settings persistence — SQLite (via sql.js, WASM, zero native deps).
 *
 * The whole AppSettings value lives as one JSON row in a single-key table. The
 * database file (e.g. `userData/app.sqlite`) is read into memory on
 * {@link openDatabase} — called from the main entry before any IPC — and
 * flushed to disk on each {@link saveSettings}. load/save are synchronous
 * against the in-memory database.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import initSqlJs, { type Database } from 'sql.js'
import type { DshEntry } from './dsh.ts'

export interface AppSettings {
  /** Directory where downloaded/installed plugins are kept. */
  pluginDir?: string
  /** Base directory holding the local dsh version repository (one subdir per version). */
  dshVersionDir?: string
  /** Registered dsh installs. */
  dshes?: DshEntry[]
  /** The currently selected dsh entry id. */
  activeDshId?: string
  /** Persisted UI language (`'zh'`/`'en'` …). */
  uiLanguage?: string
}

const KEY = 'app'
const require = createRequire(import.meta.url)

let db: Database | null = null
let dbFile = ''

function ensureDb(): Database {
  if (db === null) throw new Error('settings database is not open')
  return db
}

/** Open the settings database, loading the file if present, and create the table. */
export async function openDatabase(dbPath: string): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: (name) => require.resolve(`sql.js/dist/${name}`),
  })
  const loaded = existsSync(dbPath) ? new Uint8Array(readFileSync(dbPath)) : undefined
  db = loaded === undefined ? new SQL.Database() : new SQL.Database(loaded)
  db.run('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)')
  dbFile = dbPath
  migrateLegacyJson()
}

/** One-time import from the pre-SQLite settings.json when the DB is empty. */
function migrateLegacyJson(): void {
  const legacy = join(dirname(dbFile), 'settings.json')
  if (!existsSync(legacy)) return
  if (Object.keys(readRow()).length > 0) return
  try {
    const parsed = JSON.parse(readFileSync(legacy, 'utf8')) as AppSettings
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      saveSettings(parsed)
      renameSync(legacy, `${legacy}.bak`)
    }
  } catch {
    // Leave the legacy file untouched on any parse/export failure.
  }
}

function readRow(): AppSettings {
  const result = ensureDb().exec(`SELECT value FROM app_settings WHERE key = '${KEY}'`)
  const value = result[0]?.values[0]?.[0]
  if (value === undefined) return {}
  try {
    return JSON.parse(String(value)) as AppSettings
  } catch {
    return {}
  }
}

/** Load app settings; missing/corrupt → empty. */
export function loadSettings(): AppSettings {
  try {
    return readRow()
  } catch {
    return {}
  }
}

/** Persist settings (upsert one row) and flush the database file to disk. */
export function saveSettings(settings: AppSettings): void {
  ensureDb().run(
    `INSERT INTO app_settings (key, value) VALUES ('${KEY}', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(settings)],
  )
  writeFileSync(dbFile, Buffer.from(ensureDb().export()))
}