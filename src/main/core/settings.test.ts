/**
 * Settings persistence (sql.js): open/save/load round-trip and the one-time
 * migration from the legacy settings.json.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeToTrayEnabled, loadSettings, openDatabase, saveSettings } from './settings.ts'

let dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function freshDb(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'pm-settings-'))
  dirs.push(dir)
  return openDatabase(join(dir, 'app.sqlite')).then(() => dir)
}

describe('loadSettings / saveSettings', () => {
  beforeEach(async () => { await freshDb() })

  it('starts empty', () => {
    expect(loadSettings()).toEqual({})
  })

  it('round-trips a settings value', () => {
    saveSettings({ pluginDir: '/store' })
    expect(loadSettings()).toEqual({ pluginDir: '/store' })
  })

  it('later saves merge by replacing the row', () => {
    saveSettings({ pluginDir: '/store', uiLanguage: 'en' })
    saveSettings({ uiLanguage: 'zh' })
    expect(loadSettings()).toEqual({ uiLanguage: 'zh' })
  })

  it('closeToTrayEnabled defaults to true and reflects the stored flag', () => {
    expect(closeToTrayEnabled()).toBe(true)
    saveSettings({ closeToTray: false })
    expect(closeToTrayEnabled()).toBe(false)
    saveSettings({ closeToTray: true })
    expect(closeToTrayEnabled()).toBe(true)
  })

  it('flushes to disk so a reloaded db sees the value', async () => {
    saveSettings({ activeDshId: 'd1' })
    const dir = dirs[dirs.length - 1]
    // Re-open the same file from disk.
    await openDatabase(join(dir, 'app.sqlite'))
    expect(loadSettings()).toEqual({ activeDshId: 'd1' })
  })
})

describe('migrateLegacyJson', () => {
  it('imports a legacy settings.json into the db and renames it to .bak', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-settings-mig-')); dirs.push(dir)
    const legacy = join(dir, 'settings.json')
    writeFileSync(legacy, JSON.stringify({ pluginDir: '/legacy', onboarded: true }))
    await openDatabase(join(dir, 'app.sqlite'))
    expect(loadSettings()).toEqual({ pluginDir: '/legacy', onboarded: true })
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(`${legacy}.bak`)).toBe(true)
  })

  it('ignores an unparseable legacy file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-settings-bad-')); dirs.push(dir)
    writeFileSync(join(dir, 'settings.json'), '{not json')
    await openDatabase(join(dir, 'app.sqlite'))
    expect(loadSettings()).toEqual({})
  })
})