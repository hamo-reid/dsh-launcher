/**
 * Preset discovery: the two roots (built-in package root, writable home root),
 * the roster rules (id filter, priority order, first-root-wins) and the health
 * verdict a broken composition gets.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextForEntry } from '../profile/appState.ts'
import { discoverPresets, presetById, presetRoots, shippedPresetRoot, userPresetRoot } from './roots.ts'
import type { PresetRootInfo } from '../../../shared/types.ts'

let root: string
const home = (): string => join(root, 'home')
const userRoot = (): string => join(home(), '.agent-presets')
const ctx = (execPath = '/fake/a'): ReturnType<typeof contextForEntry> =>
  contextForEntry({ id: 'a', name: 'dsh@a', execPath, version: 'a', home: home() })

/** The dsh package dir of a fixture install: an ancestor holding package.json. */
const installDsh = (): string => join(root, 'install', 'node_modules', '@deepseek-ai', 'dsh')
const installPresets = (): string => join(root, 'install', 'node_modules', '@deepseek-ai', 'dsh-agent-presets')

/** A fixture install: the dsh package plus the built-in presets package. */
function mkInstall(): void {
  mkdirSync(installDsh(), { recursive: true })
  writeFileSync(join(installDsh(), 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
  mkdirSync(installPresets(), { recursive: true })
  writeFileSync(join(installPresets(), 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-agent-presets' }))
  mkPreset(join(installPresets(), 'presets'), 'standard', undefined, 'name: 标准模式\norder: 1\n')
}

/** A preset directory: a composition, plus metadata when given. */
function mkPreset(
  parent: string,
  id: string,
  composition = "- name: '@deepseek-ai/dsh-tool-fs'\n",
  meta?: string,
): void {
  const dir = join(parent, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), composition)
  if (meta !== undefined) writeFileSync(join(dir, 'preset.yml'), meta)
}

const userInfo = (): PresetRootInfo => ({ path: userRoot(), trust: 'user', exists: true, writable: true })
const systemInfo = (path: string): PresetRootInfo => ({ path, trust: 'system', exists: true, writable: false })

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-preset-roots-')) })

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('presetRoots', () => {
  it('offers the user root alone when nothing is installed to resolve', () => {
    expect(presetRoots(ctx())).toEqual([
      { path: userRoot(), trust: 'user', exists: false, writable: true },
    ])
  })

  it('reports an existing user root as present', () => {
    mkdirSync(userRoot(), { recursive: true })
    expect(presetRoots(ctx())[0].exists).toBe(true)
  })

  it('puts the built-in root first, then the writable user root', () => {
    mkInstall()
    const roots = presetRoots(ctx(installDsh()))
    expect(roots.map(r => [r.trust, r.path])).toEqual([
      ['system', join(installPresets(), 'presets')],
      ['user', userRoot()],
    ])
    expect(roots.map(r => r.writable)).toEqual([false, true])
  })

  it('finds no built-in root when a dsh has no install anchor', () => {
    expect(shippedPresetRoot(ctx())).toBeUndefined()
  })

  it('addresses the user root under the dsh home', () => {
    expect(userPresetRoot(ctx())).toBe(userRoot())
  })
})

describe('discoverPresets', () => {
  it('reads display metadata beside the composition', () => {
    mkPreset(userRoot(), 'mine', undefined, 'name: 我的模式\ndescription: 试一下\norder: 2\n')
    expect(discoverPresets([userInfo()])).toEqual([
      {
        id: 'mine',
        trust: 'user',
        dir: join(userRoot(), 'mine'),
        compositionPath: join(userRoot(), 'mine', 'agent.cordis.yml'),
        editable: true,
        name: '我的模式',
        description: '试一下',
        order: 2,
      },
    ])
  })

  it('leaves a built-in preset uneditable', () => {
    mkPreset(userRoot(), 'mine')
    const [row] = discoverPresets([systemInfo(userRoot())])
    expect(row.editable).toBe(false)
    expect(row.trust).toBe('system')
  })

  it('skips directories whose name no preset could claim', () => {
    mkPreset(userRoot(), 'mine')
    mkdirSync(join(userRoot(), '.DS_Store'), { recursive: true })
    mkdirSync(join(userRoot(), 'Not-An-Id'), { recursive: true })
    expect(discoverPresets([userInfo()]).map(row => row.id)).toEqual(['mine'])
  })

  it('marks a preset whose composition is missing as broken', () => {
    mkdirSync(join(userRoot(), 'ghost'), { recursive: true })
    const [row] = discoverPresets([userInfo()])
    expect(row.id).toBe('ghost')
    expect(row.broken).toContain('is missing')
  })

  it('marks a preset whose composition cannot load as broken', () => {
    mkPreset(userRoot(), 'bad', '[1, 2\n')
    expect(discoverPresets([userInfo()])[0].broken).toContain('not valid YAML')
  })

  it('orders a root by declared priority, then by id', () => {
    mkPreset(userRoot(), 'b', undefined, 'order: 2\n')
    mkPreset(userRoot(), 'a', undefined, 'order: 1\n')
    mkPreset(userRoot(), 'c', undefined, 'order: 1\n')
    mkPreset(userRoot(), 'd')
    expect(discoverPresets([userInfo()]).map(row => row.id)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('lets an earlier root win a duplicate id', () => {
    const shipped = join(root, 'system')
    mkPreset(shipped, 'standard', undefined, 'name: 内置\n')
    mkPreset(userRoot(), 'standard', undefined, 'name: 自建\n')
    const rows = discoverPresets([systemInfo(shipped), userInfo()])
    expect(rows.map(row => [row.id, row.name, row.trust])).toEqual([['standard', '内置', 'system']])
  })

  it('finds a roster row by id', () => {
    mkPreset(userRoot(), 'mine')
    const rows = discoverPresets([userInfo()])
    expect(presetById(rows, 'mine')?.id).toBe('mine')
    expect(presetById(rows, 'nope')).toBeUndefined()
  })
})
