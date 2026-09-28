/**
 * Authoring: storing display metadata, copying a preset whole, and moving one
 * to the recycle bin — every write confined to the writable root, and a
 * built-in preset refused before any filesystem work.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextForEntry } from '../profile/appState.ts'
import { AppError, E } from '../shared/errors.ts'
import { copyPreset, deletePreset, savePresetMeta, setPresetTrash } from './authoring.ts'
import { readPresetMetadata } from './metadata.ts'
import { discoverPresets } from './roots.ts'
import type { PresetRootInfo } from '../../../shared/types.ts'

let root: string
const home = (): string => join(root, 'home')
const userRoot = (): string => join(home(), '.agent-presets')
const systemRoot = (): string => join(root, 'system')
const ctx = (): ReturnType<typeof contextForEntry> =>
  contextForEntry({ id: 'a', name: 'dsh@a', execPath: '/fake/a', version: 'a', home: home() })

/** A preset directory: a composition, plus whatever else the caller adds. */
function mkPreset(parent: string, id: string, meta?: string): string {
  const dir = join(parent, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n")
  if (meta !== undefined) writeFileSync(join(dir, 'preset.yml'), meta)
  return dir
}

/** A system preset the launcher can read and copy but never write.
 *
 * The shipped root is resolved from the install chain, which a fake exec path
 * has none of, so this fixture is asserted through the roster instead of being
 * discovered by `presetRoots`. */
function systemRow(): PresetRootInfo {
  return { path: systemRoot(), trust: 'system', exists: true, writable: false }
}

/** The coded error a call refused with, or undefined when it did not throw. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof AppError) return error.code
    throw error
  }
  return undefined
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-preset-authoring-')) })

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(home(), { recursive: true, force: true })
  rmSync(systemRoot(), { recursive: true, force: true })
  mkPreset(userRoot(), 'mine', 'name: 我的模式\ndescription: 试一下\norder: 2\n')
})

afterEach(() => { setPresetTrash(null) })

describe('savePresetMeta', () => {
  it('stores name, description and priority in preset.yml', () => {
    savePresetMeta(ctx(), 'mine', { name: '新名字', description: '一句话', order: 7 })
    expect(readFileSync(join(userRoot(), 'mine', 'preset.yml'), 'utf8')).toBe(
      'name: 新名字\ndescription: 一句话\norder: 7\n',
    )
    expect(readPresetMetadata(join(userRoot(), 'mine'))).toEqual({
      name: '新名字', description: '一句话', order: 7,
    })
  })

  it('removes the file when nothing is left to publish', () => {
    savePresetMeta(ctx(), 'mine', { name: '  ', description: '', order: null })
    expect(existsSync(join(userRoot(), 'mine', 'preset.yml'))).toBe(false)
  })

  it('refuses a preset that ships with the deployment', () => {
    // A same-named directory under the system root shadows the user one, which
    // is exactly the case the roster reports as uneditable.
    mkPreset(systemRoot(), 'standard', 'name: 内置\n')
    expect(codeOf(() => savePresetMeta(ctx(), 'standard', { name: 'x', description: '', order: null })))
      .toBe(E.presetNotFound)
    expect(discoverPresets([systemRow()])[0].editable).toBe(false)
  })

  it('refuses an unknown id', () => {
    expect(codeOf(() => savePresetMeta(ctx(), 'nope', { name: 'x', description: '', order: null })))
      .toBe(E.presetNotFound)
  })
})

describe('copyPreset', () => {
  it('copies the whole directory and rewrites its metadata', () => {
    mkdirSync(join(userRoot(), 'mine', 'skills', 'helper'), { recursive: true })
    writeFileSync(join(userRoot(), 'mine', 'skills', 'helper', 'SKILL.md'), '# helper\n')
    copyPreset(ctx(), 'mine', 'copy', '复制品')
    const dest = join(userRoot(), 'copy')
    expect(existsSync(join(dest, 'agent.cordis.yml'))).toBe(true)
    expect(existsSync(join(dest, 'skills', 'helper', 'SKILL.md'))).toBe(true)
    // The source's description is kept, its name is replaced and its priority
    // is dropped: a copy that sorted into the source's slot would be a trap.
    expect(readPresetMetadata(dest)).toEqual({ name: '复制品', description: '试一下' })
  })

  it('publishes nothing when the copy is given neither a name nor a description', () => {
    mkPreset(userRoot(), 'bare')
    copyPreset(ctx(), 'bare', 'bare-copy')
    expect(existsSync(join(userRoot(), 'bare-copy', 'preset.yml'))).toBe(false)
  })

  it('refuses an id a preset already occupies', () => {
    expect(codeOf(() => copyPreset(ctx(), 'mine', 'mine'))).toBe(E.presetExists)
  })

  it('refuses an id a directory holds without a composition', () => {
    mkdirSync(join(userRoot(), 'ghost'), { recursive: true })
    expect(codeOf(() => copyPreset(ctx(), 'mine', 'ghost'))).toBe(E.presetExists)
  })

  it('refuses an id that could escape the root', () => {
    expect(codeOf(() => copyPreset(ctx(), 'mine', '../escape'))).toBe(E.presetBadId)
    expect(codeOf(() => copyPreset(ctx(), 'mine', 'Not-An-Id'))).toBe(E.presetBadId)
    expect(existsSync(join(root, 'escape'))).toBe(false)
  })

  it('refuses an unknown source', () => {
    expect(codeOf(() => copyPreset(ctx(), 'nope', 'fresh'))).toBe(E.presetNotFound)
  })
})

describe('deletePreset', () => {
  it('moves the preset directory to the recycle bin', async () => {
    const moved: string[] = []
    setPresetTrash(async (target) => { moved.push(target) })
    await deletePreset(ctx(), 'mine')
    expect(moved).toEqual([join(userRoot(), 'mine')])
  })

  it('refuses an unknown id before touching the bin', async () => {
    let called = false
    setPresetTrash(async () => { called = true })
    await expect(deletePreset(ctx(), 'nope')).rejects.toMatchObject({ code: E.presetNotFound })
    expect(called).toBe(false)
  })

  it('refuses to run without a wired mover', async () => {
    await expect(deletePreset(ctx(), 'mine')).rejects.toThrow('preset trash mover is not wired')
  })
})
