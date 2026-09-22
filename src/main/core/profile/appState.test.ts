/**
 * Aggregated app state derived from settings: dsh selection, effective dirs,
 * plugin-store/version-repo defaults and onboarding preconditions.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadSettings, openDatabase, saveSettings } from '../settings/settings.ts'
import {
  configureAppState, configuredDataRoot, dataRoot, dshEntryById, dshScopes, dshVersionDir,
  effectiveProfileDir, legacyDirOverrides, legacyProfilesDir, pluginDir, readDshState,
  skillLibraryDir, updateDshState, writeDshState,
} from './appState.ts'
import type { DshEntry } from '../../../shared/types.ts'

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
    dshes: undefined, pluginDir: undefined, dshVersionDir: undefined, dataRoot: undefined,
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

describe('updateDshState (atomic registry update)', () => {
  it('keeps a concurrent add when a late writer updates from the CURRENT list', () => {
    const a = { id: 'a', name: 'A', execPath: '/a', version: '1', home: '/ha' }
    const b = { id: 'b', name: 'B', execPath: '/b', version: '1', home: '/hb' }
    writeDshState([a])
    // A concurrent add lands while a long-running job is in flight.
    writeDshState([...readDshState().dshes, b])
    // The job then updates from the CURRENT list (not a stale handler snapshot).
    updateDshState(list => list.map(d => (d.id === 'a' ? { ...d, version: '2' } : d)))
    expect(readDshState().dshes.map(d => `${d.id}@${d.version}`)).toEqual(['a@2', 'b@1'])
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

describe('launcher data root', () => {
  const userData = (): string => join(root, 'userData')

  it('defaults every launcher dir under <userData> when unset', () => {
    expect(dataRoot()).toBe(userData())
    expect(configuredDataRoot()).toBeUndefined()
    expect(pluginDir()).toBe(join(userData(), 'plugins'))
    expect(dshVersionDir()).toBe(join(userData(), 'dsh', 'versions'))
    expect(skillLibraryDir()).toBe(join(userData(), 'skill-library'))
  })

  it('still honours the pre-dataRoot single-dir settings', () => {
    saveSettings({ pluginDir: '/store', dshVersionDir: '/versions' })
    expect(pluginDir()).toBe('/store')
    expect(dshVersionDir()).toBe('/versions')
    // The skill library never had a single-dir setting, so it keeps the default.
    expect(skillLibraryDir()).toBe(join(userData(), 'skill-library'))
  })

  it('puts all three under a configured root, superseding the single-dir settings', () => {
    saveSettings({ dataRoot: '/data', pluginDir: '/store', dshVersionDir: '/versions' })
    expect(dataRoot()).toBe('/data')
    expect(configuredDataRoot()).toBe('/data')
    expect(pluginDir()).toBe(join('/data', 'plugins'))
    expect(dshVersionDir()).toBe(join('/data', 'dsh', 'versions'))
    expect(skillLibraryDir()).toBe(join('/data', 'skill-library'))
  })

  it('restores the single-dir settings when the root is cleared (never deleted)', () => {
    saveSettings({ dataRoot: '/data', pluginDir: '/store', dshVersionDir: '/versions' })
    saveSettings({ ...loadSettings(), dataRoot: undefined })
    expect(configuredDataRoot()).toBeUndefined()
    expect(pluginDir()).toBe('/store')
    expect(dshVersionDir()).toBe('/versions')
  })
})

describe('legacyDirOverrides', () => {
  it('reports a single-dir setting left behind by an active root', () => {
    saveSettings({ dataRoot: '/data', pluginDir: '/store' })
    expect(legacyDirOverrides()).toEqual([{ key: 'pluginDir', path: '/store' }])
  })

  it('stays quiet when that setting agrees with the derived path', () => {
    saveSettings({ dataRoot: '/data', pluginDir: join('/data', 'plugins') })
    expect(legacyDirOverrides()).toEqual([])
  })

  it('stays quiet without a root — the single-dir settings are live then', () => {
    saveSettings({ pluginDir: '/store' })
    expect(legacyDirOverrides()).toEqual([])
  })
})