/**
 * Origin sidecar: kind classification, spec recording (for GitHub update
 * detection), legacy bare-string tolerance, and scoped names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readPluginSourceSpec, readPluginSources, recordPluginSource, sourceKindOf } from './store-sources.ts'

let root: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-sources-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('sourceKindOf', () => {
  it('classifies github / local / npm', () => {
    expect(sourceKindOf('github:o/r')).toBe('github')
    expect(sourceKindOf('file:/x')).toBe('local')
    expect(sourceKindOf('pkg@1.0.0')).toBe('npm')
    expect(sourceKindOf('@scope/pkg')).toBe('npm')
  })
})

describe('store sources sidecar', () => {
  it('records the spec and keeps the kind map a string map', () => {
    const dir = mkdtempSync(join(root, 'a'))
    recordPluginSource(dir, 'pkg', '1.0.0', 'github', 'github:o/r')
    recordPluginSource(dir, 'pkg2', '2.0.0', 'npm', 'pkg2@2.0.0')
    expect(readPluginSources(dir)).toEqual({ 'pkg@1.0.0': 'github', 'pkg2@2.0.0': 'npm' })
    expect(readPluginSourceSpec(dir, 'pkg')).toBe('github:o/r')
    expect(readPluginSourceSpec(dir, 'pkg2')).toBe('pkg2@2.0.0')
    expect(readPluginSourceSpec(dir, 'missing')).toBeUndefined()
  })

  it('reads a legacy bare-string sidecar (kind only, no spec)', () => {
    const dir = mkdtempSync(join(root, 'b'))
    writeFileSync(join(dir, '.pm-sources.json'), JSON.stringify({ 'x@1.0.0': 'local' }))
    expect(readPluginSources(dir)).toEqual({ 'x@1.0.0': 'local' })
    expect(readPluginSourceSpec(dir, 'x')).toBeUndefined()
  })

  it('resolves a scoped name', () => {
    const dir = mkdtempSync(join(root, 'c'))
    recordPluginSource(dir, '@s/p', '1.2.3', 'github', 'github:s/p')
    expect(readPluginSourceSpec(dir, '@s/p')).toBe('github:s/p')
  })

  it('omits the spec field when none is given', () => {
    const dir = mkdtempSync(join(root, 'd'))
    recordPluginSource(dir, 'plain', '1.0.0', 'store')
    expect(readPluginSources(dir)).toEqual({ 'plain@1.0.0': 'store' })
    expect(readPluginSourceSpec(dir, 'plain')).toBeUndefined()
  })
})
