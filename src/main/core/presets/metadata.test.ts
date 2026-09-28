/**
 * `preset.yml` reading: the host's tolerant rule — display text only, and every
 * failure degrading to no metadata rather than to a rejected preset.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPresetMetadata } from './metadata.ts'

let root: string
const dir = (): string => join(root, 'preset')

/** Write `preset.yml` (or nothing, when `text` is null). */
function meta(text: string | null): void {
  mkdirSync(dir(), { recursive: true })
  if (text !== null) writeFileSync(join(dir(), 'preset.yml'), text)
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-preset-meta-')) })

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('readPresetMetadata', () => {
  it('reads name, description and priority', () => {
    meta('name: 标准模式\ndescription: 功能完整的编码 Agent\norder: 1\n')
    expect(readPresetMetadata(dir())).toEqual({
      name: '标准模式',
      description: '功能完整的编码 Agent',
      order: 1,
    })
  })

  it('publishes nothing for an absent file', () => {
    mkdirSync(dir(), { recursive: true })
    expect(readPresetMetadata(dir())).toEqual({})
  })

  it('publishes nothing rather than throwing on malformed YAML', () => {
    meta('name: [unclosed\n')
    expect(readPresetMetadata(dir())).toEqual({})
  })

  it('ignores a document that is not a mapping', () => {
    meta('- name\n')
    expect(readPresetMetadata(dir())).toEqual({})
  })

  it('drops blank, wrongly-typed and non-finite values', () => {
    meta('name: "   "\ndescription: 42\norder: first\n')
    expect(readPresetMetadata(dir())).toEqual({})
  })

  it('keeps a zero priority', () => {
    meta('order: 0\n')
    expect(readPresetMetadata(dir())).toEqual({ order: 0 })
  })

  it('treats a !!js value as no display text', () => {
    meta('name: !!js someExpression()\ndescription: kept\n')
    expect(readPresetMetadata(dir())).toEqual({ description: 'kept' })
  })
})
