/**
 * Behavior-locking tests for the line-level `cordis.patch.yml` editor.
 *
 * These lock the exact output strings — including preserving untouched lines,
 * comments and hand-written rows — the regression risk the module exists to
 * protect against.
 */
import { describe, it, expect } from 'vitest'
import {
  parsePatchRows,
  parseNamedRows,
  parseClassifiedRows,
  setRowDisabled,
  setRowConfig,
  setRowInsert,
  upsertRow,
  removeRow,
  extractRowBlock,
  extractKeyValue,
} from './patch.ts'

describe('parsePatchRows', () => {
  it('parses row ids and disabled state', () => {
    expect(parsePatchRows('- id: a\n  disabled: true\n- id: b\n')).toEqual([
      { id: 'a', disabled: true },
      { id: 'b', disabled: false },
    ])
  })

  it('returns [] for empty text', () => {
    expect(parsePatchRows('')).toEqual([])
  })
})

describe('parseNamedRows', () => {
  it('captures the name and disabled state per block', () => {
    expect(parseNamedRows('- id: a\n  name: pkg-a\n  disabled: true\n\n- id: b\n')).toEqual([
      { id: 'a', name: 'pkg-a', disabled: true },
      { id: 'b', name: undefined, disabled: false },
    ])
  })
})

describe('parseClassifiedRows', () => {
  it('classifies shape: name/disabled/config/insert', () => {
    expect(parseClassifiedRows('- id: a\n  name: pkg-a\n  disabled: true\n  config:\n    k: v\n  insert:\n- id: b\n')).toEqual([
      { id: 'a', name: 'pkg-a', disabled: true, hasConfig: true, hasInsert: true },
      { id: 'b', name: undefined, disabled: false, hasConfig: false, hasInsert: false },
    ])
  })
})

describe('setRowDisabled', () => {
  it('appends a fresh disabled block to an empty/`[]` patch', () => {
    expect(setRowDisabled('[]', 'foo', true)).toBe('- id: foo\n  disabled: true\n')
    expect(setRowDisabled('', 'foo', true)).toBe('- id: foo\n  disabled: true\n')
  })

  it('enabling an absent row just records the enabled id', () => {
    expect(setRowDisabled('', 'foo', false)).toBe('- id: foo\n')
  })

  it('reverts a disabled row to the default by removing its override (dropping the bare id)', () => {
    expect(setRowDisabled('- id: a\n  disabled: true\n- id: b\n', 'a', false)).toBe('- id: b\n')
  })

  it('only edits the target row, preserving sibling rows byte-for-byte', () => {
    expect(setRowDisabled('- id: a\n- id: b\n  # keep me\n', 'b', true)).toBe(
      '- id: a\n- id: b\n  disabled: true\n  # keep me\n',
    )
  })
})

describe('setRowConfig', () => {
  it('writes a single-line config override into the existing block', () => {
    expect(setRowConfig('- id: a\n  config:\n    k: v\n', 'a', 'k2: v2')).toBe('- id: a\n  config: k2: v2')
  })

  it('throws when the row is absent', () => {
    expect(() => setRowConfig('- id: a\n', 'nope', 'k: v')).toThrow('not found')
  })
})

describe('setRowInsert', () => {
  it('appends an insert list to an existing row', () => {
    const out = setRowInsert('- id: a\n', 'a', ['x', 'y'])
    expect(out).toContain('  insert:')
    expect(out).toContain('    - x')
    expect(out).toContain('    - y')
  })

  it('creates the block when the row does not exist', () => {
    expect(setRowInsert('', 'foo', ['z'])).toBe('- id: foo\n  insert:\n    - z\n')
  })
})

describe('upsertRow', () => {
  it('creates a disabled row from scratch', () => {
    expect(upsertRow('', { id: 'a', disabled: true })).toBe('- id: a\n  disabled: true\n')
  })

  it('merges disabled + config onto an existing row', () => {
    expect(upsertRow('- id: a\n', { id: 'a', disabled: true, config: 'k: v' })).toContain('  disabled: true')
    expect(upsertRow('- id: a\n', { id: 'a', disabled: true, config: 'k: v' })).toContain('  config: k: v')
  })
})

describe('removeRow', () => {
  it('drops the whole block, leaving siblings intact', () => {
    expect(removeRow('- id: a\n  disabled: true\n- id: b\n', 'a')).toBe('- id: b\n')
  })

  it('is a no-op when the row is absent', () => {
    expect(removeRow('- id: a\n', 'nope')).toBe('- id: a\n')
  })
})

describe('extractRowBlock', () => {
  it('returns the verbatim `- id:` + child keys', () => {
    expect(extractRowBlock('- id: a\n  disabled: true\n- id: b\n', 'a')).toBe('- id: a\n  disabled: true')
  })
})

describe('empty-array overlay marker', () => {
  const TEMPLATE = '# Your patch layer\n[]\n'

  it('replaces a lone-`[]` template when a row is upserted', () => {
    expect(upsertRow(TEMPLATE, { id: 'a', disabled: true })).toBe('# Your patch layer\n- id: a\n  disabled: true\n')
  })

  it('setRowInsert on an empty template does not leave the `[]` marker', () => {
    const out = setRowInsert(TEMPLATE, 'a', ['x'])
    expect(out).not.toContain('[]')
    expect(out).toContain('- id: a')
    expect(out).toContain('    - x')
  })

  it('keeps nested `[]` values untouched', () => {
    const out = upsertRow('- id: a\n  config:\n    mark: []\n', { id: 'b', disabled: true })
    expect(out).toContain('    mark: []')
  })

  it('heals a historical patch that already has `[]` before real rows', () => {
    const bad = '[]\n- id: storage\n  name: "@deepseek-ai/dsh-storage"\n'
    const healed = setRowDisabled(bad, 'storage', true)
    expect(healed).not.toContain('[]')
    expect(healed).toContain('- id: storage')
    expect(healed).toContain('disabled: true')
  })
})

describe('extractKeyValue', () => {
  it('extracts a nested block value for a key', () => {
    expect(extractKeyValue('- id: a\n  config:\n    k: v\n- id: b\n', 'a', 'config')).toBe('k: v')
  })

  it('handles inline scalar values', () => {
    expect(extractKeyValue('- id: a\n  config: {q: 1}\n', 'a', 'config')).toBe('{q: 1}')
  })
})