/**
 * Tests for the pure IPC helpers: patch verification, row re-basing, README
 * image inlining and zip packing.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { addDirToZip, dedentRowBlock, inlineRelativeImages, verifyDisabledState } from './app-util.ts'

let root: string
let assetDir: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pm-apputil-'))
  assetDir = join(root, 'plugin-readme')
  mkdirSync(assetDir, { recursive: true })
  writeFileSync(join(assetDir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(assetDir, 'doc.txt'), 'text')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('verifyDisabledState', () => {
  it('requires the row to exist and be disabled when disabling', () => {
    expect(verifyDisabledState('- id: a.b\n  disabled: true\n', 'a.b', true)).toBe(true)
    expect(verifyDisabledState('- id: a.b\n  disabled: false\n', 'a.b', true)).toBe(false)
    expect(verifyDisabledState('[]\n', 'a.b', true)).toBe(false)
  })

  it('accepts a missing row when enabling', () => {
    expect(verifyDisabledState('[]\n', 'a.b', false)).toBe(true)
    expect(verifyDisabledState('- id: a.b\n  disabled: false\n', 'a.b', false)).toBe(true)
    expect(verifyDisabledState('- id: a.b\n  disabled: true\n', 'a.b', false)).toBe(false)
  })
})

describe('dedentRowBlock', () => {
  it('strips the common leading indent but keeps relative nesting', () => {
    const block = '  - id: "x"\n    key: 1\n  - id: "y"\n'
    expect(dedentRowBlock(block)).toBe('- id: "x"\n  key: 1\n- id: "y"\n')
  })

  it('leaves already-unindented lines untouched', () => {
    expect(dedentRowBlock('a\nb')).toBe('a\nb')
  })

  it('handles leading blank/empty first line gracefully', () => {
    expect(dedentRowBlock('')).toBe('')
  })
})

describe('inlineRelativeImages', () => {
  it('rewrites a local img src to a data URL', () => {
    const out = inlineRelativeImages('<img src="logo.png">', assetDir)
    expect(out).toMatch(/^<img src="data:image\/png;base64,[A-Za-z0-9+/=]+">$/)
  })

  it('rewrites a markdown relative image', () => {
    const out = inlineRelativeImages('![alt](logo.png)', assetDir)
    expect(out).toMatch(/^!\[\]\(data:image\/png;base64,/)
  })

  it('leaves external / data: / anchor sources untouched', () => {
    const html = '<img src="https://x.com/a.png"> <img src="data:image/b"> <img src="#sprite">'
    expect(inlineRelativeImages(html, assetDir)).toBe(html)
  })

  it('leaves a missing file or unsupported extension untouched', () => {
    expect(inlineRelativeImages('<img src="nope.png">', assetDir)).toBe('<img src="nope.png">')
    expect(inlineRelativeImages('<img src="doc.txt">', assetDir)).toBe('<img src="doc.txt">')
  })
})

describe('addDirToZip', () => {
  it('packs files and skips node_modules', () => {
    const src = join(root, 'zip-src')
    mkdirSync(join(src, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    writeFileSync(join(src, 'index.js'), 'code')
    writeFileSync(join(src, 'node_modules', '@deepseek-ai', 'dsh', 'lib.js'), 'dep')

    const zip = new AdmZip()
    addDirToZip(zip, src, 'plugin')
    const names = zip.getEntries().map(e => e.entryName)
    expect(names).toContain('plugin/index.js')
    expect(names).not.toContain('plugin/node_modules/@deepseek-ai/dsh/lib.js')
  })
})