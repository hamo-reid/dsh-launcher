/**
 * Active-dsh home and profile discovery: directory derivation from the active
 * entry, profile listing, and patch-path helpers.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, saveSettings } from './settings.ts'
import { dshHome, homePatchPath, listProfiles, profileDir, profilesDir } from './home.ts'

let root: string
const home = (): string => join(root, 'home')

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-home-'))
  await openDatabase(join(root, 'app.sqlite'))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Point the app at a single active dsh whose home is the per-test tree. */
function setActive(entry?: { profilesDir?: string }): void {
  saveSettings({
    dshes: [{ id: 'a', name: 'dsh@a', execPath: '/a', version: 'a', home: home(), ...entry }],
    activeDshId: 'a',
  })
}

describe('directory resolution', () => {
  it('dshHome follows the active entry home', () => {
    setActive()
    expect(dshHome()).toBe(home())
  })

  it('profilesDir is <home>/profiles by default', () => {
    setActive()
    expect(profilesDir()).toBe(join(home(), 'profiles'))
  })

  it('profilesDir honours the active entry override', () => {
    setActive({ profilesDir: '/custom' })
    expect(profilesDir()).toBe('/custom')
  })

  it('profileDir nests under profilesDir', () => {
    setActive()
    expect(profileDir('p1')).toBe(join(home(), 'profiles', 'p1'))
  })

  it('homePatchPath points to <home>/cordis.patch.yml', () => {
    setActive()
    expect(homePatchPath()).toBe(join(home(), 'cordis.patch.yml'))
  })
})

describe('listProfiles', () => {
  it('returns only directories that own a package.json, sorted', () => {
    const disposable = join(root, 'disposable')
    saveSettings({
      dshes: [
        { id: 'a', name: 'dsh@a', execPath: '/a', version: 'a', home: disposable, profilesDir: join(disposable, 'custom') },
      ],
      activeDshId: 'a',
    })
    mkdirSync(join(disposable, 'custom', 'zeta'), { recursive: true })
    writeFileSync(join(disposable, 'custom', 'zeta', 'package.json'), '{}')
    mkdirSync(join(disposable, 'custom', 'alpha'), { recursive: true })
    writeFileSync(join(disposable, 'custom', 'alpha', 'package.json'), '{}')
    mkdirSync(join(disposable, 'custom', 'no-manifest'), { recursive: true })
    expect(listProfiles()).toEqual(['alpha', 'zeta'])
  })

  it('returns [] when the profiles dir does not exist', () => {
    setActive({ profilesDir: join(root, 'does-not-exist') })
    expect(listProfiles()).toEqual([])
  })
})