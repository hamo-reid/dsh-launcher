/**
 * Aggregated app state derived from settings: dsh selection, effective dirs,
 * plugin-store/version-repo defaults and onboarding preconditions.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, openDatabase, saveSettings } from './settings.ts'
import {
  activeDshEntry, configureAppState, dshScopes, dshVersionDir, effectiveProfileDir,
  pluginDir, readDshState, writeDshState,
} from './appState.ts'
import type { DshEntry } from '../../shared/types.ts'

let root: string

const ENTRY_A: DshEntry = { id: 'a', name: 'dsh@a', execPath: '/a', version: 'a', home: '/home/a' }

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-appstate-'))
  await openDatabase(join(root, 'app.sqlite'))
  configureAppState(join(root, 'userData'))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  saveSettings({
    ...loadSettings(),
    dshes: undefined, activeDshId: undefined, pluginDir: undefined, dshVersionDir: undefined,
  })
})

describe('dsh state', () => {
  it('starts with no dshes and no active id', () => {
    expect(readDshState()).toEqual({ dshes: [], activeDshId: undefined })
    expect(activeDshEntry()).toBeUndefined()
  })

  it('writeDshState persists entries + active id; activeDshEntry resolves it', () => {
    writeDshState([ENTRY_A, { ...ENTRY_A, id: 'b', name: 'dsh@b' }], 'a')
    expect(activeDshEntry()?.id).toBe('a')
    expect(readDshState().activeDshId).toBe('a')
  })

  it('activeDshEntry is undefined when the active id matches nothing', () => {
    writeDshState([ENTRY_A], 'missing')
    expect(activeDshEntry()).toBeUndefined()
  })

  it('dshScopes carries each entry into a scope', () => {
    writeDshState([
      { ...ENTRY_A },
      { ...ENTRY_A, id: 'b', name: 'dsh@b', home: '/home/b', profilesDir: '/pb' },
    ], undefined)
    expect(dshScopes()).toEqual([
      { id: 'a', name: 'dsh@a', version: 'a', home: '/home/a', profilesDir: undefined },
      { id: 'b', name: 'dsh@b', version: 'a', home: '/home/b', profilesDir: '/pb' },
    ])
  })
})

describe('effectiveProfileDir', () => {
  it('defaults to <home>/profiles without an override', () => {
    expect(effectiveProfileDir({ ...ENTRY_A })).toBe(join('/home/a', 'profiles'))
  })
  it('uses the configured override when present, ignoring blank', () => {
    expect(effectiveProfileDir({ ...ENTRY_A, profilesDir: '/custom' })).toBe('/custom')
    expect(effectiveProfileDir({ ...ENTRY_A, profilesDir: '   ' })).toBe(join('/home/a', 'profiles'))
  })
})

describe('directory defaults', () => {
  it('pluginDir falls back to <userData>/plugins', () => {
    expect(pluginDir()).toBe(join(root, 'userData', 'plugins'))
  })
  it('pluginDir honours the configured value', () => {
    saveSettings({ pluginDir: '/store' })
    expect(pluginDir()).toBe('/store')
  })
  it('dshVersionDir defaults to <userData>/dsh/versions', () => {
    expect(dshVersionDir()).toBe(join(root, 'userData', 'dsh', 'versions'))
  })
  it('dshVersionDir honours the configured value', () => {
    saveSettings({ dshVersionDir: '/versions' })
    expect(dshVersionDir()).toBe('/versions')
  })
})