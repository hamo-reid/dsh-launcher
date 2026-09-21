/**
 * A dsh's home and profile discovery, all keyed by an explicit DshContext.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextForEntry } from './appState.ts'
import { listProfileInfos, listProfiles, profilesDir, readHomePatch, writeHomePatch } from './home.ts'
import type { DshContext } from './appState.ts'
import type { DshEntry } from '../../../shared/types.ts'

let root: string
const home = (): string => join(root, 'home')

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-home-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A context for a dsh whose home is the per-test tree. */
function ctx(over: Partial<DshEntry> = {}): DshContext {
  return contextForEntry({ id: 'a', name: 'dsh@a', execPath: '/a', version: 'a', home: home(), ...over })
}

describe('directory resolution', () => {
  it('profilesDir is <home>/profiles (the host contract)', () => {
    expect(profilesDir(ctx())).toBe(join(home(), 'profiles'))
  })
})

describe('listProfiles', () => {
  it('returns only directories that own a package.json, sorted', () => {
    const disposable = join(root, 'disposable')
    const c = ctx({ home: disposable })
    mkdirSync(join(disposable, 'profiles', 'zeta'), { recursive: true })
    writeFileSync(join(disposable, 'profiles', 'zeta', 'package.json'), '{}')
    mkdirSync(join(disposable, 'profiles', 'alpha'), { recursive: true })
    writeFileSync(join(disposable, 'profiles', 'alpha', 'package.json'), '{}')
    mkdirSync(join(disposable, 'profiles', 'no-manifest'), { recursive: true })
    expect(listProfiles(c)).toEqual(['alpha', 'zeta'])
  })

  it('returns [] when the profiles dir does not exist', () => {
    expect(listProfiles(ctx({ home: join(root, 'does-not-exist') }))).toEqual([])
  })
})

describe('listProfileInfos', () => {
  it('lists profiles with manifest counts', () => {
    const otherHome = join(root, 'other-home')
    const c = ctx({ home: otherHome })
    mkdirSync(join(otherHome, 'profiles', 'beta'), { recursive: true })
    writeFileSync(join(otherHome, 'profiles', 'beta', 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      dependencies: { foo: '^1' },
    }))
    mkdirSync(join(otherHome, 'profiles', 'alpha'), { recursive: true })
    writeFileSync(join(otherHome, 'profiles', 'alpha', 'package.json'), '{}')

    expect(listProfileInfos(c)).toEqual([
      { name: 'alpha', bundles: 0, dependencies: 0 },
      { name: 'beta', bundles: 2, dependencies: 1 },
    ])
  })

  it('returns [] when the context has no profiles dir', () => {
    expect(listProfileInfos(ctx({ home: join(root, 'empty-home') }))).toEqual([])
  })
})

describe('home patch (source mode)', () => {
  it('reads empty then round-trips a valid patch, rejecting a non-array one', () => {
    const h = join(root, 'hp-home')
    mkdirSync(h, { recursive: true })
    const c = ctx({ home: h })
    expect(readHomePatch(c).text).toBe('')
    writeHomePatch(c, '- id: a\n')
    expect(readHomePatch(c).text).toBe('- id: a\n')
    expect(() => writeHomePatch(c, 'id: a\n')).toThrow(/顶层/)
  })
})
