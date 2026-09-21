/**
 * The settings file on disk: the atomic replace, the backup mirror, and moving
 * aside a file that could not be opened.
 *
 * Each function takes the database path it acts on rather than reading the
 * store's module state, so the crash-safety path can be read on its own.
 */
import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Database } from 'sql.js'
import { logger } from '../shared/logger.ts'

/** How many archived/unusable files to retain before pruning the oldest. */
const MAX_ARCHIVES = 3

/** Move an unusable file aside so it is never silently overwritten. */
export function archiveFile(path: string): void {
  try {
    const dest = `${path}.corrupt-${Date.now()}`
    renameSync(path, dest)
    logger.error(`settings: archived unusable file to ${dest}`)
  } catch (error) {
    logger.error(`settings: could not archive ${path}`, error)
  }
}

/** Keep the app data dir tidy: retain only the newest few archives. */
export function pruneArchives(dbFile: string): void {
  try {
    const dir = dirname(dbFile)
    const prefix = `${basename(dbFile)}.corrupt-`
    const archives = readdirSync(dir).filter(name => name.startsWith(prefix)).sort()
    for (const name of archives.slice(0, Math.max(0, archives.length - MAX_ARCHIVES))) {
      try { rmSync(join(dir, name), { force: true }) } catch { /* ignore */ }
    }
  } catch { /* best-effort */ }
}

/** Export the in-memory DB and replace `app.sqlite` atomically (fsync + rename). */
export function flushToDisk(dbi: Database, dbFile: string): void {
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
export function snapshotBackup(dbFile: string): void {
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
