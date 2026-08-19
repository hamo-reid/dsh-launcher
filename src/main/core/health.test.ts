/**
 * Tests for the disk-vs-app health aggregate: missing dsh executables/homes,
 * an unconfigured or missing store, and store plugins whose dir is gone.
 * Pure — builds temp trees only, no real pnpm or Electron.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkHealth } from './health.ts'
import type { DshEntry } from '../../shared/types.ts'

let root = ''
function dir(...segments: string[]): string {
  const p = join(root, ...segments)
  mkdirSync(p, { recursive: true })
  return p
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-health-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const entry = (execPath: string, home: string): DshEntry =>
  ({ id: execPath, name: 'd', execPath, version: '1', home })

describe('checkHealth', () => {
  it('returns no issues for a healthy dsh + store', () => {
    const shim = join(dir('dsh/.bin'), 'dsh.cmd')
    writeFileSync(shim, '@echo off')
    const home = dir('dsh/home')
    const store = dir('store')
    writeFileSync(join(store, 'package.json'), JSON.stringify({ name: 'store', private: true, dependencies: { p1: '^1.0.0' } }))
    writeFileSync(join(dir('store/node_modules/p1'), 'package.json'), JSON.stringify({ name: 'p1', version: '1.0.0' }))

    expect(checkHealth([entry(shim, home)], store)).toEqual([])
  })

  it('flags a dsh whose executable is missing', () => {
    const home = dir('dsh-home')
    const store = dir('s1')
    writeFileSync(join(store, 'package.json'), JSON.stringify({ name: 'store', private: true, dependencies: {} }))
    const shim = join(root, 'gone', 'dsh.cmd') // does not exist
    expect(checkHealth([entry(shim, home)], store))
      .toContainEqual({ kind: 'dsh-exec', label: 'd', path: shim, missing: true })
  })

  it('does not flag a missing home (normal before first run, created lazily)', () => {
    const shim = join(dir('dsh2/.bin'), 'dsh.cmd')
    writeFileSync(shim, '@echo off')
    const missingHome = join(root, 'no-home') // never created
    const store = dir('s2')
    writeFileSync(join(store, 'package.json'), JSON.stringify({ name: 'store', private: true, dependencies: {} }))
    expect(checkHealth([entry(shim, missingHome)], store)).toEqual([])
  })

  it('flags an unconfigured plugin store', () => {
    const shim = join(dir('dsh3/.bin'), 'dsh.cmd')
    writeFileSync(shim, '@echo off')
    expect(checkHealth([entry(shim, dir('dsh3/home'))], ''))
      .toContainEqual({ kind: 'store-unconfigured', label: 'plugin store', missing: true })
  })

  it('flags a configured-but-missing store dir', () => {
    const shim = join(dir('dsh4/.bin'), 'dsh.cmd')
    writeFileSync(shim, '@echo off')
    expect(checkHealth([entry(shim, dir('dsh4/home'))], join(root, 'no-store')))
      .toContainEqual({ kind: 'store-missing', label: join(root, 'no-store'), path: join(root, 'no-store'), missing: true })
  })

  it('flags a store plugin whose dir is missing', () => {
    const shim = join(dir('dsh5/.bin'), 'dsh.cmd')
    writeFileSync(shim, '@echo off')
    const store = dir('s5')
    writeFileSync(join(store, 'package.json'), JSON.stringify({ name: 'store', private: true, dependencies: { gone: '^2.0.0' } }))
    // package.json lists `gone`, but node_modules/gone is absent.
    expect(checkHealth([entry(shim, dir('dsh5/home'))], store))
      .toContainEqual({ kind: 'plugin-missing', label: 'gone', path: join(store, 'node_modules', 'gone'), missing: true })
  })
})