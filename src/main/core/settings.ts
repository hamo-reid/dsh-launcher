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
 */
import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import { logger } from './logger.ts'
import type { DshEntry } from './dsh.ts'
import type { DevPlugin, LaunchOptions, MarketSource, RunMode } from '../../shared/types.ts'

/** The merged settings shape callers see (a union of the three stored rows). */
export interface AppSettings {
  /** Directory where downloaded/installed plugins are kept. */
  pluginDir?: string
  /** Base directory holding the local dsh version repository (one subdir per version). */
  dshVersionDir?: string
  /** Registered dsh installs. */
  dshes?: DshEntry[]
  /** Persisted UI language (`'zh'`/`'en'` …). */
  uiLanguage?: string
  /** Whether clicking close minimizes to the system tray instead of quitting.
   * Defaults to `true`; a false (or absent-on-older-schema) value quits. */
  closeToTray?: boolean
  /** Whether clicking close asks the user (minimize-to-tray vs quit) each time.
   * Defaults to `true`; a false value uses `closeToTray` directly without
   * prompting (set both when the user ticks "don't ask again"). */
  askOnClose?: boolean
  /** Which node to run dsh with when the user chooses explicitly. `'system'`
   * uses a usable system node (falling back to bundled if none/too old);
   * `'bundled'` always uses the bundled Node. Defaults to `'system'`. */
  nodePreference?: 'system' | 'bundled'
  /** Whether the first-run onboarding wizard has been completed. */
  onboarded?: boolean
  /** Which origin the community market loads its catalog from (`'official'`
   * = the canonical `plugins.json`; `'custom'` = a user-supplied mirror URL). */
  marketSource?: MarketSource
  /** Custom market catalog URL, used when `marketSource === 'custom'`. */
  marketUrl?: string
  /** The user's GitHub token, encrypted at rest (see `core/github-auth.ts`).
   * A secret: never exported and never logged. */
  githubTokenEnc?: string
  /** Registered local development plugins (linked, not archived). Launcher-only
   * state: independent of the plugin store. */
  devPlugins?: DevPlugin[]
  /** Saved default launch parameters, keyed `pid:<profileId>` (a stable id
   * stored in each profile dir; see `core/launch-config.ts`). Kept out of the
   * profile manifest on purpose so machine-specific patch paths never leak into
   * an exported/imported profile. */
  launchOptions?: Record<string, LaunchOptions>
  /** Last run mode per stable profile id, keyed `pid:<profileId>`, so relaunching
   * keeps the user's app/shell choice instead of resetting to `app`. */
  runModes?: Record<string, RunMode>
}

/** The `prefs` row: user preferences (no registry / no per-profile config). */
type PrefsSettings = Pick<AppSettings,
  'pluginDir' | 'dshVersionDir' | 'uiLanguage' | 'closeToTray' | 'askOnClose' |
  'nodePreference' | 'onboarded' | 'marketSource' | 'marketUrl' | 'githubTokenEnc' | 'devPlugins'>
/** The `dsh` row: the registered dsh installs. */
type DshSettings = Pick<AppSettings, 'dshes'>
/** The `launch` row: per-profile launch config. */
type LaunchSettings = Pick<AppSettings, 'launchOptions' | 'runModes'>

/** Row keys in `app_settings`. `legacy` is the pre-split single-row blob. */
const ROW = { prefs: 'prefs', dsh: 'dsh', launch: 'launch', meta: 'meta', legacy: 'app' } as const

/** How many archived/unusable files to retain before pruning the oldest. */
const MAX_ARCHIVES = 3

/** Current on-disk schema version. Bump when a migration is added. */
export const CURRENT_SCHEMA_VERSION = 1

type Migration = (s: AppSettings) => AppSettings
/** Ordered migrations keyed by the version they upgrade FROM (`v → v+1`).
 * 0 → 1 is the storage split, handled structurally, so no data-shape step. */
const MIGRATIONS: Record<number, Migration> = {}

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
  snapshotBackup()
  pruneArchives()
  logger.info(`settings db opened: ${dbPath} (schema v${schemaVersion}${loaded.recovered ? ', recovered from backup' : ''})`)
}

type LoadAttempt = { db: Database; error?: undefined } | { db?: undefined; error: 'missing' | 'empty' | 'unreadable' }

/** Load one DB file, validating that the settings table is queryable. */
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

/** Move an unusable file aside so it is never silently overwritten. */
function archiveFile(path: string): void {
  try {
    const dest = `${path}.corrupt-${Date.now()}`
    renameSync(path, dest)
    logger.error(`settings: archived unusable file to ${dest}`)
  } catch (error) {
    logger.error(`settings: could not archive ${path}`, error)
  }
}

/** Keep the app data dir tidy: retain only the newest {@link MAX_ARCHIVES}. */
function pruneArchives(): void {
  try {
    const dir = dirname(dbFile)
    const prefix = `${basename(dbFile)}.corrupt-`
    const archives = readdirSync(dir).filter(name => name.startsWith(prefix)).sort()
    for (const name of archives.slice(0, Math.max(0, archives.length - MAX_ARCHIVES))) {
      try { rmSync(join(dir, name), { force: true }) } catch { /* ignore */ }
    }
  } catch { /* best-effort */ }
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
  flushToDisk(ensureDb())
  snapshotBackup()
}

/** Force any coalesced write to disk now (lifecycle boundaries, tests). */
export function flushSettings(): void {
  pending = false
  flushToDisk(ensureDb())
  snapshotBackup()
}

/** Export the settings plus a header, for backup / migration. The GitHub token
 * is a secret and is deliberately left out of the export. */
export function exportSettings(): string {
  const app = loadSettings()
  delete app.githubTokenEnc
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
  // An export never carries the token; keep the one already on this machine.
  const existingToken = current.githubTokenEnc
  current = existingToken !== undefined ? { ...migrated, githubTokenEnc: existingToken } : migrated
  schemaVersion = CURRENT_SCHEMA_VERSION
  lastSignature = ''
  persist()
  flushSettings()
}

/** Export the in-memory DB and replace `app.sqlite` atomically (fsync + rename). */
function flushToDisk(dbi: Database): void {
  const data = Buffer.from(dbi.export())
  const tmp = `${dbFile}.tmp`
  let written = false
  try {
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, dbFile)
    written = true
  } catch (error) {
    // Windows can transiently lock the target (antivirus / indexer). Fall back
    // to a direct write so a save is never lost; drop the temp file first.
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    try { writeFileSync(dbFile, data); written = true } catch (fallbackError) {
      logger.error('settings: flush failed', fallbackError)
    }
    logger.warn(`settings atomic write fell back to direct write: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (written) logger.debug('settings saved')
}

/** Mirror the last good primary to `<file>.bak` (via a temp + rename). */
function snapshotBackup(): void {
  if (dbFile === '' || !existsSync(dbFile)) return
  const tmp = `${dbFile}.bak.tmp`
  try {
    writeFileSync(tmp, readFileSync(dbFile))
    renameSync(tmp, `${dbFile}.bak`)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    logger.warn(`settings: backup snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── split / normalize ────────────────────────────────────────────────────────

function splitPrefs(s: AppSettings): PrefsSettings {
  return {
    ...(s.pluginDir !== undefined ? { pluginDir: s.pluginDir } : {}),
    ...(s.dshVersionDir !== undefined ? { dshVersionDir: s.dshVersionDir } : {}),
    ...(s.uiLanguage !== undefined ? { uiLanguage: s.uiLanguage } : {}),
    ...(s.closeToTray !== undefined ? { closeToTray: s.closeToTray } : {}),
    ...(s.askOnClose !== undefined ? { askOnClose: s.askOnClose } : {}),
    ...(s.nodePreference !== undefined ? { nodePreference: s.nodePreference } : {}),
    ...(s.onboarded !== undefined ? { onboarded: s.onboarded } : {}),
    ...(s.marketSource !== undefined ? { marketSource: s.marketSource } : {}),
    ...(s.marketUrl !== undefined ? { marketUrl: s.marketUrl } : {}),
    ...(s.githubTokenEnc !== undefined ? { githubTokenEnc: s.githubTokenEnc } : {}),
    ...(s.devPlugins !== undefined ? { devPlugins: s.devPlugins } : {}),
  }
}

function splitDsh(s: AppSettings): DshSettings {
  return s.dshes !== undefined ? { dshes: s.dshes } : {}
}

function splitLaunch(s: AppSettings): LaunchSettings {
  const out: LaunchSettings = {}
  if (s.launchOptions !== undefined) out.launchOptions = s.launchOptions
  if (s.runModes !== undefined) out.runModes = s.runModes
  return out
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isDshEntry(v: unknown): v is DshEntry {
  return isRecord(v) && typeof v.id === 'string' && typeof v.execPath === 'string' && typeof v.home === 'string'
}

/** Coerce an arbitrary parsed value into a valid `AppSettings`, dropping bad
 * fields. Defends against hand-edited / partially-corrupt input. */
/** Normalize the dev-plugin registry. Entries need a name + dir; the rest is
 * best-effort, since settings may be hand-edited or written by an older build. */
function readDevPlugins(raw: unknown): DevPlugin[] {
  if (!Array.isArray(raw)) return []
  const out: DevPlugin[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const dir = typeof item.dir === 'string' ? item.dir.trim() : ''
    if (name === '' || dir === '') continue
    const shims = Array.isArray(item.shims) ? item.shims.filter((s): s is string => typeof s === 'string') : []
    const rawBuild = item.build
    const build = isRecord(rawBuild) && typeof rawBuild.script === 'string' && rawBuild.script.trim() !== ''
      ? { script: rawBuild.script.trim(), scope: rawBuild.scope === 'workspace' ? 'workspace' as const : 'package' as const }
      : undefined
    out.push({
      name,
      dir,
      ...(typeof item.workspaceRoot === 'string' && item.workspaceRoot !== '' ? { workspaceRoot: item.workspaceRoot } : {}),
      ...(typeof item.version === 'string' && item.version !== '' ? { version: item.version } : {}),
      bundle: item.bundle === true,
      ...(build !== undefined ? { build } : {}),
      ...(shims.length > 0 ? { shims } : {}),
      addedAt: typeof item.addedAt === 'string' && item.addedAt !== '' ? item.addedAt : new Date(0).toISOString(),
    })
  }
  return out
}

export function normalizeSettings(raw: unknown): AppSettings {
  if (!isRecord(raw)) return {}
  const out: AppSettings = {}
  const nonEmptyString = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v : undefined
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

  const pluginDir = nonEmptyString(raw.pluginDir)
  if (pluginDir !== undefined) out.pluginDir = pluginDir
  const dshVersionDir = nonEmptyString(raw.dshVersionDir)
  if (dshVersionDir !== undefined) out.dshVersionDir = dshVersionDir
  const uiLanguage = nonEmptyString(raw.uiLanguage)
  if (uiLanguage !== undefined) out.uiLanguage = uiLanguage
  const closeToTray = bool(raw.closeToTray)
  if (closeToTray !== undefined) out.closeToTray = closeToTray
  const askOnClose = bool(raw.askOnClose)
  if (askOnClose !== undefined) out.askOnClose = askOnClose
  if (raw.nodePreference === 'system' || raw.nodePreference === 'bundled') out.nodePreference = raw.nodePreference
  const onboarded = bool(raw.onboarded)
  if (onboarded !== undefined) out.onboarded = onboarded
  if (raw.marketSource === 'official' || raw.marketSource === 'custom') out.marketSource = raw.marketSource
  const marketUrl = nonEmptyString(raw.marketUrl)
  if (marketUrl !== undefined) out.marketUrl = marketUrl
  const githubTokenEnc = nonEmptyString(raw.githubTokenEnc)
  if (githubTokenEnc !== undefined) out.githubTokenEnc = githubTokenEnc
  if (Array.isArray(raw.dshes)) out.dshes = raw.dshes.filter(isDshEntry)
  const devPlugins = readDevPlugins(raw.devPlugins)
  if (devPlugins.length > 0) out.devPlugins = devPlugins
  if (isRecord(raw.launchOptions)) out.launchOptions = raw.launchOptions as Record<string, LaunchOptions>
  if (isRecord(raw.runModes)) {
    const modes: Record<string, RunMode> = {}
    for (const [key, value] of Object.entries(raw.runModes)) if (value === 'app' || value === 'shell') modes[key] = value
    out.runModes = modes
  }
  return out
}

function runMigrations(data: AppSettings, from: number): { data: AppSettings; version: number } {
  let next = data
  let version = from
  while (version < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version]
    if (step !== undefined) next = step(next)
    version += 1
  }
  return { data: next, version: Math.max(version, from) }
}

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
