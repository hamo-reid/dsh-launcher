/**
 * Dev plugin version freshness.
 *
 * The recorded version is written once at registration and is display-only. A
 * package bumped afterwards kept showing the old number, which made the one
 * label in that view disagree with the working copy — while everything beside
 * it (status, broken links) is computed live.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../settings/settings.ts'
import { listDevPlugins, registerDevPlugin, syncDevVersions } from './dev.ts'

let root: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-dev-version-'))
  await openDatabase(join(root, 'app.sqlite'))
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Write a minimal package manifest for a dev plugin. */
function makePackage(dir: string, name: string, version: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
}

describe('syncDevVersions', () => {
  it('picks up a version bumped after registration, and persists it', () => {
    const dir = join(root, 'bumped')
    makePackage(dir, '@me/bumped', '1.0.0')
    registerDevPlugin(dir)
    expect(listDevPlugins().find(p => p.name === '@me/bumped')?.version).toBe('1.0.0')

    makePackage(dir, '@me/bumped', '1.1.0')
    expect(syncDevVersions().find(p => p.name === '@me/bumped')?.version).toBe('1.1.0')
    // Written back, not merely returned: the next list must not need the sync again.
    expect(listDevPlugins().find(p => p.name === '@me/bumped')?.version).toBe('1.1.0')
  })

  it('keeps the recorded version when the manifest cannot be read', () => {
    // An unreadable package.json is not evidence that the version changed; erasing
    // the label would trade one wrong display for another.
    const dir = join(root, 'vanished')
    makePackage(dir, '@me/vanished', '2.0.0')
    registerDevPlugin(dir)
    rmSync(join(dir, 'package.json'))

    expect(syncDevVersions().find(p => p.name === '@me/vanished')?.version).toBe('2.0.0')
  })

  it('leaves an unchanged plugin exactly as it was', () => {
    const dir = join(root, 'steady')
    makePackage(dir, '@me/steady', '3.0.0')
    registerDevPlugin(dir)

    const before = listDevPlugins().find(p => p.name === '@me/steady')
    const after = syncDevVersions().find(p => p.name === '@me/steady')
    expect(after).toEqual(before)
  })
})
