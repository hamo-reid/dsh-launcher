/**
 * readManifest: parses a profile's package.json into ordered bundles, dependency
 * names and a display name.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, saveSettings } from './settings.ts'
import { readManifest } from './manifest.ts'

let root: string
const profiles = (): string => join(root, 'home', 'profiles')

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-manifest-'))
  await openDatabase(join(root, 'app.sqlite'))
  saveSettings({
    dshes: [{ id: 'a', name: 'dsh@a', execPath: '/a', version: 'a', home: join(root, 'home') }],
    activeDshId: 'a',
  })
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
    expect(readManifest('p1')).toEqual({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      dependencies: ['dep-a', 'dep-b'],
      displayName: 'dsh-profile-p1',
    })
  })

  it('falls back to the profile name when manifest has no name', () => {
    writeProfile('noname', { dependencies: { x: '1' } })
    expect(readManifest('noname')).toEqual({ bundles: [], dependencies: ['x'], displayName: 'noname' })
  })

  it('handles a manifest missing every optional section', () => {
    writeProfile('bare', {})
    expect(readManifest('bare')).toEqual({ bundles: [], dependencies: [], displayName: 'bare' })
  })
})