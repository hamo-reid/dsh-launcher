/**
 * readManifest: parses a profile's package.json into ordered bundles, dependency
 * names and a display name.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextForEntry } from './appState.ts'
import { readManifest } from './manifest.ts'

let root: string
const home = (): string => join(root, 'home')
const profiles = (): string => join(home(), 'profiles')
const ctx = (): ReturnType<typeof contextForEntry> =>
  contextForEntry({ id: 'a', name: 'dsh@a', execPath: '/a', version: 'a', home: home() })

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pm-manifest-'))
  mkdirSync(profiles(), { recursive: true })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

function writeProfile(name: string, manifest: Record<string, unknown>): void {
  const dir = join(profiles(), name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
}

describe('readManifest', () => {
  it('reads bundles, dependency names and display name', () => {
    writeProfile('p1', {
      name: 'dsh-profile-p1',
      dependencies: { 'dep-a': '^1.0.0', 'dep-b': 'link:/x' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    })
    expect(readManifest(ctx(), 'p1')).toEqual({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      dependencies: ['dep-a', 'dep-b'],
      displayName: 'dsh-profile-p1',
    })
  })

  it('falls back to the profile name when manifest has no name', () => {
    writeProfile('noname', { dependencies: { x: '1' } })
    expect(readManifest(ctx(), 'noname')).toEqual({ bundles: [], dependencies: ['x'], displayName: 'noname' })
  })

  it('handles a manifest missing every optional section', () => {
    writeProfile('bare', {})
    expect(readManifest(ctx(), 'bare')).toEqual({ bundles: [], dependencies: [], displayName: 'bare' })
  })
})
