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
  collectInsertIds,
  assertPatchDocValid,
  setRowDisabled,
  setRowConfig,
  setRowInsert,
  upsertRow,
  removeRow,
  appendInsertChild,
  removeInsertRow,
  extractRowBlock,
  extractKeyValue,
  setConfigScalar,
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

  // A preset declaration's `config.plugins` is a list of plugin rows that carry
  // `disabled:` of their own — the shipped `standard` preset disables several.
  // Reading the first of those as the declaration's own clause hid the preset
  // from the roster entirely, so the row's own fields stop at its child indent.
  it('reads a row\'s OWN fields, never one nested inside its config', () => {
    const shipped = [
      '- insert:',
      '    - id: preset-standard',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: standard',
      '        order: 1',
      '        plugins:',
      '          - id: tool-subagent-codex',
      "            name: '@deepseek-ai/dsh-tool-subagent'",
      '            disabled: true',
      '          - id: shell',
      '            name: cordis:group',
      '            group: true',
      '            config:',
      '              - id: inner',
      "                name: '@deepseek-ai/dsh-terminal'",
      '                disabled: true',
      '',
    ].join('\n')
    const row = parseClassifiedRows(shipped).find(r => r.id === 'preset-standard')
    expect(row).toEqual({
      id: 'preset-standard',
      name: '@deepseek-ai/dsh-agent-preset',
      disabled: false,
      hasConfig: true,
      hasInsert: false,
    })
    // The nested rows are still visible as rows in their own right.
    expect(parseClassifiedRows(shipped).map(r => r.id)).toEqual([
      'preset-standard', 'tool-subagent-codex', 'shell', 'inner',
    ])
    expect(parsePatchRows(shipped)).toEqual([
      { id: 'preset-standard', disabled: false },
      { id: 'tool-subagent-codex', disabled: true },
      { id: 'shell', disabled: false },
      { id: 'inner', disabled: true },
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

describe('block end (nested list values)', () => {
  const ROW = [
    '- id: mcp',
    '  config:',
    '    args:',
    '      - serve',
    '    env:',
    '      A: 1',
    '- id: other',
    '',
  ].join('\n')

  it('does not truncate a row at its own block-style list', () => {
    expect(extractKeyValue(ROW, 'mcp', 'config')).toBe('args:\n  - serve\nenv:\n  A: 1')
  })

  it('still ends a row at a same-indent sibling', () => {
    expect(removeRow(ROW, 'mcp')).toBe('- id: other\n')
  })

  it('ends a nested child at its sibling, not at its own list item', () => {
    const text = [
      '- insert:',
      '    - id: a',
      '      config:',
      '        args:',
      '          - x',
      '    - id: b',
      '',
    ].join('\n')
    expect(extractKeyValue(text, 'a', 'config')).toBe('args:\n  - x')
    expect(removeRow(text, 'a')).toBe('- insert:\n    - id: b\n')
  })
})

describe('appendInsertChild', () => {
  it('creates the insert block on an empty or template layer', () => {
    expect(appendInsertChild('[]\n', ['    - id: a'])).toBe('- insert:\n    - id: a\n')
    expect(appendInsertChild('', ['    - id: a'])).toBe('- insert:\n    - id: a\n')
  })

  it('reuses an existing top-level insert block', () => {
    expect(appendInsertChild('- insert:\n    - id: a\n', ['    - id: b'])).toBe(
      '- insert:\n    - id: a\n    - id: b\n',
    )
  })

  it('keeps sibling rows that follow the block', () => {
    expect(appendInsertChild('- insert:\n    - id: a\n\n- id: c\n', ['    - id: b'])).toBe(
      '- insert:\n    - id: a\n    - id: b\n\n- id: c\n',
    )
  })

  it('appends a fresh block after a non-insert row', () => {
    expect(appendInsertChild('- id: x\n  disabled: true\n', ['    - id: a'])).toBe(
      '- id: x\n  disabled: true\n- insert:\n    - id: a\n',
    )
  })
})

describe('removeInsertRow', () => {
  it('drops the child and the now-empty insert block', () => {
    expect(removeInsertRow('- insert:\n    - id: a\n', 'a')).toBe('')
  })

  it('keeps the block while a sibling child remains', () => {
    expect(removeInsertRow('- insert:\n    - id: a\n    - id: b\n', 'a')).toBe('- insert:\n    - id: b\n')
  })

  it('delegates a top-level row to removeRow', () => {
    expect(removeInsertRow('- id: a\n- id: b\n', 'a')).toBe('- id: b\n')
  })

  it('is a no-op for an absent row', () => {
    expect(removeInsertRow('- insert:\n    - id: a\n', 'zz')).toBe('- insert:\n    - id: a\n')
  })
})

describe('collectInsertIds', () => {
  it('collects ids nested under an insert key, not id-targeted patch rows', () => {
    const text = [
      '- id: tools',
      '  config:',
      '    mode: native',
      '- insert:',
      '    - id: subagent-model-selection-settings',
      "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
      '    - id: code-runtime',
      "      name: '@deepseek-ai/dsh-code-runtime-worker-thread'",
      '',
    ].join('\n')
    expect(collectInsertIds(text)).toEqual(['subagent-model-selection-settings', 'code-runtime'])
  })

  it('collects a nested insert block without losing its siblings', () => {
    const text = [
      '- insert:',
      '    - id: group',
      "      name: '@x/group'",
      '      insert:',
      '        - id: child',
      "          name: '@x/child'",
      '    - id: sibling',
      "      name: '@x/sibling'",
      '',
    ].join('\n')
    expect(collectInsertIds(text)).toEqual(['group', 'child', 'sibling'])
  })

  it('returns [] for an empty template or a patch with no inserts', () => {
    expect(collectInsertIds('[]\n')).toEqual([])
    expect(collectInsertIds('# just a comment\n- id: a\n  disabled: true\n')).toEqual([])
  })
})

describe('assertPatchDocValid', () => {
  it('accepts a top-level list (including an empty one)', () => {
    expect(() => assertPatchDocValid('[]\n')).not.toThrow()
    expect(() => assertPatchDocValid('- id: a\n  disabled: true\n')).not.toThrow()
  })

  it('rejects malformed YAML and a non-array document', () => {
    expect(() => assertPatchDocValid('- id: a\n  bad: [\n')).toThrow()
    expect(() => assertPatchDocValid('id: a\n')).toThrow(/顶层/)
    expect(() => assertPatchDocValid('')).toThrow()
  })

  it('skips the deep check when cordis !!js tags are present', () => {
    expect(() => assertPatchDocValid('mode: !!js process.env.X\n')).not.toThrow()
  })
})

// A declaration row as the launcher writes one into a profile patch, carrying
// both things a whole-config re-render would destroy: a `!!js` gate and a `|`
// block scalar. Every scalar edit below must leave this region byte-identical.
const DECLARATION = [
  '- insert:',
  '    - id: local-preset-mine',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: mine',
  '        name: My mode',
  '        description: A mode.',
  '        plugins:',
  '          - id: persona',
  "            name: '@deepseek-ai/dsh-persona'",
  '            config:',
  '              prefix: hello',
  '          - id: gate',
  "            name: '@deepseek-ai/dsh-agent-instructions'",
  "            disabled: !!js process.platform === 'win32'",
  '          - id: shell',
  '            name: cordis:group',
  '            group: true',
  '            config:',
  '              - id: pty',
  "                name: '@deepseek-ai/dsh-terminal'",
  '                config:',
  '                  description: |-',
  '                    line one',
  '                    line two',
  '',
].join('\n')

/** The `plugins:` region of {@link DECLARATION}, verbatim. */
const PLUGINS_REGION = DECLARATION.slice(DECLARATION.indexOf('        plugins:')).trimEnd()

describe('setConfigScalar', () => {
  it('replaces one scalar and leaves the plugins block byte-identical', () => {
    const next = setConfigScalar(DECLARATION, 'local-preset-mine', 'name', 'Renamed')
    expect(next).toContain('        name: Renamed')
    expect(next).not.toContain('        name: My mode')
    expect(next).toContain(PLUGINS_REGION)
    // Exactly one line changed.
    expect(next.split('\n').length).toBe(DECLARATION.split('\n').length)
  })

  it('inserts a new scalar right after `id:` and preserves the rest', () => {
    const next = setConfigScalar(DECLARATION, 'local-preset-mine', 'order', 5)
    expect(next).toContain('        id: mine\n        order: 5\n        name: My mode')
    expect(next).toContain("            disabled: !!js process.platform === 'win32'")
    expect(next).toContain('                    line two')
  })

  it('removes the key when the value is empty rather than writing it null', () => {
    const dropped = setConfigScalar(DECLARATION, 'local-preset-mine', 'description', undefined)
    expect(dropped).not.toContain('description: A mode.')
    expect(dropped).toContain(PLUGINS_REGION)
    expect(setConfigScalar(DECLARATION, 'local-preset-mine', 'name', '   ')).not.toContain('name: My mode')
  })

  it('is idempotent for the same value', () => {
    const once = setConfigScalar(DECLARATION, 'local-preset-mine', 'description', 'A mode.')
    expect(setConfigScalar(once, 'local-preset-mine', 'description', 'A mode.')).toBe(once)
  })

  it('quotes a value YAML would otherwise misread, and blocks a multi-line one', () => {
    const colon = setConfigScalar(DECLARATION, 'local-preset-mine', 'description', 'uses: colons')
    expect(colon).toContain("description: 'uses: colons'")
    const multi = setConfigScalar(DECLARATION, 'local-preset-mine', 'description', 'one\ntwo')
    expect(multi).toContain('        description: |-\n          one\n          two')
  })

  it('throws when the row is absent or its config is spelled inline', () => {
    expect(() => setConfigScalar(DECLARATION, 'nope', 'name', 'x')).toThrow(/not found/)
    expect(() => setConfigScalar('- id: a\n  config: { id: a }\n', 'a', 'name', 'x')).toThrow(/block-form/)
    expect(() => setConfigScalar('- id: a\n  name: pkg\n', 'a', 'name', 'x')).toThrow(/block-form/)
  })

  it('never lets an empty description be re-added as a null key', () => {
    const cleared = setConfigScalar(DECLARATION, 'local-preset-mine', 'description', '')
    // The plugins region has its own, deeper `description:` — only the config's
    // own (its immediate children) must be gone.
    expect(cleared).not.toContain('\n        description:')
    expect(cleared).toContain(PLUGINS_REGION)
  })
})