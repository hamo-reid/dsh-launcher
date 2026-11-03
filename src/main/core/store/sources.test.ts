/**
 * Origin sidecar: kind classification, spec recording (for GitHub update
 * detection), legacy bare-string tolerance, and scoped names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readPluginSourceRegistry, readPluginSourceSpec, readPluginSources, recordPluginSource, sourceKindOf } from './sources.ts'

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

describe('registry origin', () => {
  it('round-trips the id of the registry that answered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-sources-reg-'))
    try {
      recordPluginSource(dir, '@team/pkg', '1.0.0', 'npm', '@team/pkg@1.0.0', 'team')
      expect(readPluginSourceRegistry(dir, '@team/pkg')).toBe('team')
      // The kind and the spec are unaffected by the extra field.
      expect(readPluginSourceSpec(dir, '@team/pkg')).toBe('@team/pkg@1.0.0')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers nothing for a package that came from the public registry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-sources-pub-'))
    try {
      recordPluginSource(dir, 'lodash', '4.0.0', 'npm', 'lodash@4.0.0')
      expect(readPluginSourceRegistry(dir, 'lodash')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a record written before the field existed', () => {
    // Store files from earlier builds are real input; a missing id is not an error.
    const dir = mkdtempSync(join(tmpdir(), 'pm-sources-old-'))
    try {
      writeFileSync(join(dir, '.pm-sources.json'), JSON.stringify({ 'old@1.0.0': { kind: 'npm', spec: 'old@1.0.0' } }))
      expect(readPluginSourceRegistry(dir, 'old')).toBeUndefined()
      expect(readPluginSources(dir)['old@1.0.0']).toBe('npm')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})