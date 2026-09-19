/**
 * Aggregated app state derived from settings: dsh selection, effective dirs,
 * plugin-store/version-repo defaults and onboarding preconditions.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadSettings, openDatabase, saveSettings } from './settings.ts'
import {
  configureAppState, dshEntryById, dshScopes, dshVersionDir, effectiveProfileDir,
  legacyProfilesDir, pluginDir, readDshState, writeDshState,
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
    dshes: undefined, pluginDir: undefined, dshVersionDir: undefined,
  })
})

describe('dsh state', () => {
  it('starts with no dshes', () => {
    expect(readDshState()).toEqual({ dshes: [] })
    expect(dshEntryById('a')).toBeUndefined()
  })

  it('writeDshState persists entries; dshEntryById resolves one', () => {
    writeDshState([ENTRY_A, { ...ENTRY_A, id: 'b', name: 'dsh@b' }])
    expect(dshEntryById('a')?.id).toBe('a')
    expect(dshEntryById('b')?.name).toBe('dsh@b')
  })

  it('dshEntryById is undefined for an unknown / empty id', () => {
    writeDshState([ENTRY_A])
    expect(dshEntryById('missing')).toBeUndefined()
    expect(dshEntryById(undefined)).toBeUndefined()
  })

  it('dshScopes carries each entry into a scope', () => {
    writeDshState([
      { ...ENTRY_A },
      { ...ENTRY_A, id: 'b', name: 'dsh@b', home: '/home/b' },
    ])
    expect(dshScopes()).toEqual([
      { id: 'a', name: 'dsh@a', version: 'a', home: '/home/a', execPath: '/a' },
      { id: 'b', name: 'dsh@b', version: 'a', home: '/home/b', execPath: '/a' },
    ])
  })
})

describe('effectiveProfileDir', () => {
  it('is always <home>/profiles, matching the host layout', () => {
    expect(effectiveProfileDir({ ...ENTRY_A })).toBe(join('/home/a', 'profiles'))
  })
})

describe('legacyProfilesDir', () => {
  it('is undefined without a stale override', () => {
    expect(legacyProfilesDir({ ...ENTRY_A })).toBeUndefined()
  })
  it('surfaces a stale override that differs from <home>/profiles', () => {
    const entry = { ...ENTRY_A, profilesDir: '/custom' } as DshEntry
    expect(legacyProfilesDir(entry)).toBe(resolve('/custom'))
  })
  it('ignores an override that resolves to the canonical dir, or a blank one', () => {
    expect(legacyProfilesDir({ ...ENTRY_A, profilesDir: join('/home/a', 'profiles') } as DshEntry)).toBeUndefined()
    expect(legacyProfilesDir({ ...ENTRY_A, profilesDir: '   ' } as DshEntry)).toBeUndefined()
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