/**
 * Enterprise settings persistence: in-memory singleton + atomic
 * read-modify-write, schema versioning, split-row storage, and corruption
 * self-heal.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import {
  loadSettings, openDatabase, patchSettings, saveSettings, updateSettings, exportSettings, flushSettings,
  importSettings,
} from './settings.ts'

const require = createRequire(import.meta.url)
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-settings-store-'))
  dirs.push(dir)
  return dir
}

/** Write a raw sqlite file with the given app_settings rows (bypasses the API). */
async function writeRawDb(file: string, rows: Record<string, string>): Promise<void> {
  const SQL = await initSqlJs({ locateFile: (name: string) => require.resolve(`sql.js/dist/${name}`) })
  const db = new SQL.Database()
  db.run('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)')
  for (const [key, value] of Object.entries(rows)) {
    db.run('INSERT INTO app_settings (key, value) VALUES (?, ?)', [key, value])
  }
  writeFileSync(file, Buffer.from(db.export()))
}

describe('atomic updates', () => {
  it('updateSettings merges; patchSettings never drops other fields', async () => {
    const dir = tmpDir()
    await openDatabase(join(dir, 'app.sqlite'))
    saveSettings({ pluginDir: '/store', uiLanguage: 'en' })
    patchSettings({ uiLanguage: 'zh' })
    expect(loadSettings()).toEqual({ pluginDir: '/store', uiLanguage: 'zh' })
    updateSettings(draft => { draft.nodePreference = 'bundled' })
    expect(loadSettings()).toEqual({ pluginDir: '/store', uiLanguage: 'zh', nodePreference: 'bundled' })
  })
})

describe('split storage + schema version', () => {
  it('round-trips through the split rows on a reload', async () => {
    const dir = tmpDir()
    const file = join(dir, 'app.sqlite')
    await openDatabase(file)
    saveSettings({ pluginDir: '/store', dshes: [], runModes: { 'pid:x': 'shell' } })
    await openDatabase(file) // reload from disk (split rows)
    expect(loadSettings()).toEqual({ pluginDir: '/store', dshes: [], runModes: { 'pid:x': 'shell' } })
  })

  it('splits a legacy single-row blob on first open', async () => {
    const dir = tmpDir()
    const file = join(dir, 'app.sqlite')
    const legacy = { pluginDir: '/legacy', closeToTray: false, runModes: { 'pid:a': 'app' } }
    await writeRawDb(file, { app: JSON.stringify(legacy) })
    await openDatabase(file)
    expect(loadSettings()).toEqual(legacy)
    // Re-open: the value survives the (now split) layout.
    await openDatabase(file)
    expect(loadSettings()).toEqual(legacy)
  })
})

describe('corruption self-heal', () => {
  it('archives an unparseable row and starts from the rest', async () => {
    const dir = tmpDir()
    const file = join(dir, 'app.sqlite')
    await writeRawDb(file, {
      prefs: '{ not json',
      meta: JSON.stringify({ schemaVersion: 1 }),
    })
    await openDatabase(file)
    expect(loadSettings()).toEqual({})
    const archived = readdirSync(dir).some(name => name.includes('.corrupt-prefs-'))
    expect(archived).toBe(true)
  })
})

describe('file-level backup recovery', () => {
  it('recovers from .bak when the primary file is unreadable', async () => {
    const dir = tmpDir()
    const file = join(dir, 'app.sqlite')
    await openDatabase(file)
    saveSettings({ uiLanguage: 'zh' }) // writes the primary + mirrors .bak
    expect(existsSync(`${file}.bak`)).toBe(true)

    writeFileSync(file, Buffer.from('garbage that is not a sqlite database'))
    await openDatabase(file)

    expect(loadSettings()).toEqual({ uiLanguage: 'zh' })
    const archived = readdirSync(dir).some(name => name.startsWith('app.sqlite.corrupt-'))
    expect(archived).toBe(true)
  })
})

describe('export / import', () => {
  it('round-trips settings and refuses a newer schema', async () => {
    const dir = tmpDir()
    await openDatabase(join(dir, 'app.sqlite'))
    saveSettings({ pluginDir: '/store', dshes: [] })
    const json = exportSettings()
    saveSettings({ pluginDir: '/other' })
    importSettings(json)
    expect(loadSettings()).toEqual({ pluginDir: '/store', dshes: [] })
    expect(() => importSettings(JSON.stringify({ schemaVersion: 999, app: {} }))).toThrow()
  })
})

describe('coalesced flush', () => {
  it('lands every coalesced update once flushed', async () => {
    const dir = tmpDir()
    const file = join(dir, 'app.sqlite')
    await openDatabase(file)
    patchSettings({ pluginDir: '/a' })
    patchSettings({ uiLanguage: 'zh' })
    flushSettings()
    await openDatabase(file)
    expect(loadSettings()).toEqual({ pluginDir: '/a', uiLanguage: 'zh' })
  })
})
