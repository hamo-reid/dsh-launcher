/**
 * Stable profile ids + the launch-config key scheme they back, plus the one-time
 * legacy `<dshId>::<name>` → `pid:<id>` migration.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, openDatabase, saveSettings } from '../settings/settings.ts'
import { configureAppState, contextForEntry, writeDshState } from './appState.ts'
import {
  clearDshLaunchConfig, clearLaunchConfig, ensureProfileId, migrateLaunchConfigKeys, profileId,
  readLaunchOptions, readProfileId, readRunMode, writeLaunchOptions, writeNewProfileId, writeRunMode,
} from './launch-config.ts'
import type { DshEntry } from '../../../shared/types.ts'

let root: string
let home: string
const ENTRY: DshEntry = { id: 'dsh-a', name: 'dsh@a', execPath: '/a', version: '1.0.0', home: '' }

/** Create a minimal but listable profile dir (needs a package.json manifest). */
function makeProfile(name: string): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, dsh: { profile: { bundles: [] } } }))
  return dir
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-launch-config-'))
  home = join(root, 'home')
  mkdirSync(join(home, 'profiles'), { recursive: true })
  await openDatabase(join(root, 'app.sqlite'))
  configureAppState(join(root, 'userData'))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  saveSettings({ ...loadSettings(), dshes: undefined, launchOptions: undefined, runModes: undefined })
})

describe('stable profile id', () => {
  it('creates and persists an id on first use, stable across calls', () => {
    const dir = makeProfile('alpha')
    const id = ensureProfileId(dir)
    expect(id).not.toBe('')
    expect(existsSync(join(dir, '.dsh-launcher-id'))).toBe(true)
    expect(ensureProfileId(dir)).toBe(id)
    expect(readProfileId(dir)).toBe(id)
  })

  it('readProfileId is empty for a profile without a sidecar', () => {
    const dir = makeProfile('beta')
    expect(readProfileId(dir)).toBe('')
  })

  it('writeNewProfileId assigns a distinct id (clone/import identity)', () => {
    const dir = makeProfile('gamma')
    const a = writeNewProfileId(dir)
    const b = writeNewProfileId(dir)
    expect(a).not.toBe(b)
    expect(readProfileId(dir)).toBe(b)
  })

  it('keeps the id across a directory rename', () => {
    makeProfile('delta')
    const ctx = contextForEntry({ ...ENTRY, home })
    const id = profileId(ctx, 'delta')
    renameSync(join(home, 'profiles', 'delta'), join(home, 'profiles', 'delta-renamed'))
    expect(profileId(ctx, 'delta-renamed')).toBe(id)
  })
})

describe('launch config by id', () => {
  it('defaults to empty options and app mode', () => {
    expect(readLaunchOptions('x')).toEqual({})
    expect(readRunMode('x')).toBe('app')
  })

  it('round-trips options and run mode', () => {
    writeLaunchOptions('x', { args: ['--foo'], patches: ['/p.yml'], env: { A: '1' }, port: 3000 })
    writeRunMode('x', 'shell')
    expect(readLaunchOptions('x')).toEqual({ args: ['--foo'], patches: ['/p.yml'], env: { A: '1' }, port: 3000 })
    expect(readRunMode('x')).toBe('shell')
  })

  it('clearLaunchConfig drops both entries', () => {
    writeLaunchOptions('x', { args: [] })
    writeRunMode('x', 'shell')
    clearLaunchConfig('x')
    expect(readLaunchOptions('x')).toEqual({})
    expect(readRunMode('x')).toBe('app')
  })

  it('clearDshLaunchConfig clears every profile under the dsh', () => {
    const ctx = contextForEntry({ ...ENTRY, home })
    for (const n of ['p1', 'p2']) {
      const id = ensureProfileId(makeProfile(n))
      writeLaunchOptions(id, { args: [n] })
      writeRunMode(id, 'shell')
    }
    // A pre-migration legacy key must also be dropped.
    saveSettings({ ...loadSettings(), launchOptions: { ...(loadSettings().launchOptions ?? {}), 'dsh-a::p1': { args: ['legacy'] } } })
    clearDshLaunchConfig('dsh-a', ctx)
    const s = loadSettings()
    const leftover = Object.values(s.launchOptions ?? {}).flatMap(o => o.args ?? [])
    expect(leftover).not.toContain('p1')
    expect(leftover).not.toContain('p2')
    expect(s.launchOptions?.['dsh-a::p1']).toBeUndefined()
  })
})

describe('migrateLaunchConfigKeys', () => {
  it('re-keys legacy <dshId>::<name> entries onto the profile id', () => {
    const dir = makeProfile('m1')
    writeDshState([{ ...ENTRY, home }])
    saveSettings({
      ...loadSettings(),
      launchOptions: { 'dsh-a::m1': { args: ['legacy'] } },
      runModes: { 'dsh-a::m1': 'shell' },
    })
    migrateLaunchConfigKeys()
    const id = readProfileId(dir)
    expect(id).not.toBe('')
    const s = loadSettings()
    expect(s.launchOptions?.[`pid:${id}`]).toEqual({ args: ['legacy'] })
    expect(s.runModes?.[`pid:${id}`]).toBe('shell')
    expect(s.launchOptions?.['dsh-a::m1']).toBeUndefined()
  })

  it('is a no-op once every key is id-based', () => {
    writeLaunchOptions('stable', { args: ['keep'] })
    const before = { ...loadSettings().launchOptions }
    migrateLaunchConfigKeys()
    expect(loadSettings().launchOptions).toEqual(before)
  })
})
