/**
 * Behavior tests for the first-run decision: a genuinely fresh install should
 * trigger the onboarding wizard, while an onboarded user or an upgraded user
 * with existing data should not.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, openDatabase, saveSettings } from './settings.ts'
import { shouldRunOnboarding } from './appState.ts'

let root: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-onboarding-'))
  await openDatabase(join(root, 'app.sqlite'))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Drop every onboarding-relevant field, so each test starts fresh. */
function resetSettings(): void {
  saveSettings({
    ...loadSettings(),
    onboarded: undefined,
    pluginDir: undefined,
    dshVersionDir: undefined,
    dshes: undefined,
  })
}

describe('shouldRunOnboarding', () => {
  beforeEach(() => resetSettings())

  it('is true on a genuinely fresh install (empty settings row)', () => {
    expect(shouldRunOnboarding()).toBe(true)
  })

  it('is false once onboarding has completed', () => {
    saveSettings({ onboarded: true })
    expect(shouldRunOnboarding()).toBe(false)
  })

  it('is true when the flag is explicitly false and no data exists yet', () => {
    saveSettings({ onboarded: false })
    expect(shouldRunOnboarding()).toBe(true)
  })

  it('is false for an upgraded user with a pluginDir but no flag', () => {
    saveSettings({ pluginDir: '/some/store' })
    expect(shouldRunOnboarding()).toBe(false)
  })

  it('is false for an upgraded user with a dshVersionDir but no flag', () => {
    saveSettings({ dshVersionDir: '/some/versions' })
    expect(shouldRunOnboarding()).toBe(false)
  })

  it('is false for an upgraded user with registered dshes but no flag', () => {
    saveSettings({ dshes: [{ id: 'd1', name: 'd1', execPath: 'd1', version: '', home: '/h' }] })
    expect(shouldRunOnboarding()).toBe(false)
  })
})