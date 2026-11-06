/**
 * Native dialog copy: Chinese keeps the strings the dialogs already showed (moving
 * them into one table is not a retranslation), English follows the UI language the
 * renderer saved, and a title and its file-type filter always come from one entry.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, updateSettings } from '../settings/settings.ts'
import { dialogFilter, dialogTitle } from './dialog-text.ts'

let root: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-dialog-text-'))
  await openDatabase(join(root, 'app.sqlite'))
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  updateSettings((draft) => { delete draft.uiLanguage })
})

describe('native dialog copy', () => {
  it('answers in Chinese until a language is chosen', () => {
    expect(dialogTitle('skillZip')).toBe('选择要导入的 skill 压缩包')
    expect(dialogFilter('skillZip', ['zip'])).toEqual({ name: 'Skill 压缩包', extensions: ['zip'] })
  })

  it('follows the UI language the renderer saved', () => {
    // Without this an English UI popped Chinese dialogs: a native window is drawn by
    // the main process, which has no i18n bundle of its own.
    updateSettings((draft) => { draft.uiLanguage = 'en' })
    expect(dialogTitle('skillFolder')).toBe('Choose a skill folder')
    expect(dialogFilter('pluginZip', ['zip'])).toEqual({ name: 'Plugin package', extensions: ['zip'] })
  })

  it('names what a profile export is about', () => {
    updateSettings((draft) => { draft.uiLanguage = 'en' })
    expect(dialogTitle('profileExportZip', { name: 'web' })).toBe('Export web')
    updateSettings((draft) => { draft.uiLanguage = 'zh' })
    expect(dialogTitle('profileExportZip', { name: 'web' })).toBe('导出 web')
  })

  it('carries the extensions the caller accepts, with its own label', () => {
    expect(dialogFilter('importProfile', ['json', 'zip']))
      .toEqual({ name: 'Profile 导出', extensions: ['json', 'zip'] })
  })
})
