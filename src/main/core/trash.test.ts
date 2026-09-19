/**
 * Behavior tests for the soft-delete trash: list / restore / refuse-on-conflict /
 * delete / empty. Uses a tmp home + an explicit dsh context.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextForEntry } from './appState.ts'
import { softDeleteProfile } from './profile.ts'
import { deleteTrashItem, emptyTrash, listTrashItems, restoreTrashItem, trashDir } from './trash.ts'

let root: string
let home: string
let profilesDir: string
const ctx = (): ReturnType<typeof contextForEntry> =>
  contextForEntry({ id: 'd1', name: 'd1', execPath: 'd1', version: '', home })

function makeProfile(name: string, bundles: string[], deps: string[] = [], patch = ''): void {
  const dir = join(profilesDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: Object.fromEntries(deps.map(d => [d, '^1.0.0'])),
    dsh: { profile: { bundles } },
  }, null, 2))
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pm-trash-'))
  home = join(root, 'home')
  profilesDir = join(home, 'profiles')
  mkdirSync(profilesDir, { recursive: true })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('trash', () => {
  it('lists a soft-deleted profile with its manifest-derived fields', () => {
    makeProfile('p1', ['@deepseek-ai/a', '@deepseek-ai/b'], ['foo', 'bar'])
    softDeleteProfile(ctx(), 'p1')
    const items = listTrashItems(ctx())
    const item = items.find(i => i.name === 'p1')
    expect(item).toBeDefined()
    expect(item?.bundles).toEqual(['@deepseek-ai/a', '@deepseek-ai/b'])
    expect(item?.deps).toEqual(['foo', 'bar'])
    expect(item?.sizeBytes).toBeGreaterThan(0)
    expect(item?.deletedAt).not.toBe('')
  })

  it('counts patch rows and skips non-manifest folders', () => {
    makeProfile('p2', [], [], '- id: a\n  disabled: true\n')
    mkdirSync(join(profilesDir, '.trash', 'loose-dir'), { recursive: true }) // no package.json
    softDeleteProfile(ctx(), 'p2')
    const item = listTrashItems(ctx()).find(i => i.name === 'p2')
    expect(item?.patchRows).toBe(1)
    expect(listTrashItems(ctx()).find(i => i.name === 'loose-dir')).toBeUndefined()
  })

  it('restores a profile back to the profiles dir', () => {
    makeProfile('p3', ['@deepseek-ai/a'])
    softDeleteProfile(ctx(), 'p3')
    expect(existsSync(join(profilesDir, 'p3'))).toBe(false)
    restoreTrashItem(ctx(), 'p3')
    expect(existsSync(join(profilesDir, 'p3', 'package.json'))).toBe(true)
    expect(listTrashItems(ctx()).some(i => i.name === 'p3')).toBe(false)
  })

  it('refuses to restore over a name that already exists', () => {
    makeProfile('p4', ['@deepseek-ai/a'])
    softDeleteProfile(ctx(), 'p4')
    makeProfile('p4', ['@deepseek-ai/other']) // a fresh profile with the same name
    expect(() => restoreTrashItem(ctx(), 'p4')).toThrow(/同名/)
  })

  it('permanently deletes a single item', () => {
    makeProfile('p5', ['@deepseek-ai/a'])
    softDeleteProfile(ctx(), 'p5')
    deleteTrashItem(ctx(), 'p5')
    expect(existsSync(join(trashDir(ctx()), 'p5'))).toBe(false)
    expect(listTrashItems(ctx()).some(i => i.name === 'p5')).toBe(false)
  })

  it('empties every entry but keeps the trash dir', () => {
    makeProfile('p6', ['@deepseek-ai/a'])
    makeProfile('p7', ['@deepseek-ai/b'])
    softDeleteProfile(ctx(), 'p6')
    softDeleteProfile(ctx(), 'p7')
    const removed = emptyTrash(ctx())
    expect(removed).toBeGreaterThanOrEqual(2)
    expect(listTrashItems(ctx())).toEqual([])
    expect(existsSync(trashDir(ctx()))).toBe(true)
  })

  it('auto-numbers a colliding soft-delete instead of failing', () => {
    makeProfile('dup', ['@deepseek-ai/a'])
    softDeleteProfile(ctx(), 'dup')            // trash/dup
    makeProfile('dup', ['@deepseek-ai/a']) // recreate
    softDeleteProfile(ctx(), 'dup')            // trash/dup occupied → trash/dup (2)
    const names = listTrashItems(ctx()).map(i => i.name)
    expect(names).toContain('dup')
    expect(names).toContain('dup (2)')
  })

  it('restores a numbered trash item to its base name', () => {
    makeProfile('baseA', ['@deepseek-ai/a'])
    softDeleteProfile(ctx(), 'baseA')              // trash/baseA
    makeProfile('baseA', ['@deepseek-ai/b']) // fresh copy
    softDeleteProfile(ctx(), 'baseA')              // trash/baseA (2)
    // Keep only the numbered entry, and clear the active copy.
    deleteTrashItem(ctx(), 'baseA')
    rmSync(join(profilesDir, 'baseA'), { recursive: true, force: true })
    restoreTrashItem(ctx(), 'baseA (2)')
    expect(existsSync(join(profilesDir, 'baseA', 'package.json'))).toBe(true)
  })
})
