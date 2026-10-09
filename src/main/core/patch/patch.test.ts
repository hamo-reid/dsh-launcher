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

  // A preset declaration's `config.plugins` is a list of plugin rows, each with
  // an `id`, a `name` and often a `disabled:` of its own — the shipped `standard`
  // preset disables several. That roster is the preset's PRIVATE DATA: the host
  // builds loader entries from the patch's `insert:` lists, never from an entry's
  // `config`, so reading those ids as rows invents entries no layer inserts.
  // (It also, at first, hid the preset itself: an indent-blind scan read the
  // roster's first `disabled: true` as the declaration's own clause.)
  it('reads a row\'s OWN fields, and never the roster nested inside its config', () => {
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
    // The declaration is the layer's only row; the roster and the groups inside
    // it are not this layer's entries.
    expect(parseClassifiedRows(shipped).map(r => r.id)).toEqual(['preset-standard'])
    expect(parsePatchRows(shipped)).toEqual([{ id: 'preset-standard', disabled: false }])
    expect(collectInsertIds(shipped)).toEqual(['preset-standard'])
  })

  // The one `config` a walk must descend into: a GROUP entry's, which IS a nested
  // entry list (`applyEntryPatches` inserts into it). Group-ness is declared by
  // `group: true` or by the group plugin's name.
  it('descends into a group entry\'s config, which is an entry list of its own', () => {
    const text = [
      '- insert:',
      '    - id: shell',
      '      name: cordis:group',
      '      config:',
      '        - id: child-a',
      "          name: '@x/a'",
      '    - id: sibling',
      "      name: '@x/b'",
      '- id: host',
      '  name: cordis:group',
      '  group: true',
      '  config:',
      '    - id: child-b',
      "      name: '@x/c'",
      '',
    ].join('\n')
    expect(parseNamedRows(text).map(r => r.id)).toEqual(['shell', 'child-a', 'sibling', 'host', 'child-b'])
    // Inside an insert list everything the layer contributes is inserted, a
    // group's children included. A top-level `- id: host` row is a PATCH whose
    // config REPLACES the group's list, so its children are rows but not inserts.
    expect(collectInsertIds(text)).toEqual(['shell', 'child-a', 'sibling'])
  })

  // A patch file may be indented as a whole; top-level items are then the first
  // `- ` line's indent, not column 0.
  it('finds the top-level items of a wholly indented document', () => {
    const text = '  - id: a\n    disabled: true\n'
    expect(parsePatchRows(text)).toEqual([{ id: 'a', disabled: true }])
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

  it('reads an id-targeted insert list, and ignores an insert nested in an entry', () => {
    const text = [
      '- id: shell',
      '  insert:',
      '    - id: child',
      "      name: '@x/child'",
      '    - id: sibling',
      "      name: '@x/sibling'",
      '- id: other',
      '  config:',
      '    insert:',
      '      - id: not-an-entry',
      '',
    ].join('\n')
    expect(collectInsertIds(text)).toEqual(['child', 'sibling'])
  })

  it('returns [] for an empty template or a patch with no inserts', () => {
    expect(collectInsertIds('[]\n')).toEqual([])
    expect(collectInsertIds('# just a comment\n- id: a\n  disabled: true\n')).toEqual([])
  })
})

describe('CRLF patch files', () => {
  /**
   * One declaration row with a roster, every value on its own line — the shape a
   * Windows editor hands back after saving a file that was written as LF.
   */
  const LF = [
    '- insert:',
    '    - id: local-preset-mine',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      disabled: false',
    '      config:',
    '        id: mine',
    '        plugins:',
    '          - id: gate',
    "            name: '@deepseek-ai/dsh-agent-instructions'",
    "            disabled: !!js process.platform === 'win32'",
    '',
  ].join('\n')
  const crlf = (text: string): string => text.replace(/\n/g, '\r\n')

  it('reads the same values out of a CRLF file as out of its LF twin', () => {
    // `.` does not match `\r` and `$` is the end of the input, so a `(.*)$` value
    // match used to FAIL on a CRLF line rather than capture one character too
    // many — every scalar child of such a file read as absent. That is the whole
    // preset roster gone, not one field.
    expect(parseNamedRows(crlf(LF))).toEqual(parseNamedRows(LF))
    expect(parseClassifiedRows(crlf(LF))).toEqual(parseClassifiedRows(LF))
    expect(collectInsertIds(crlf(LF))).toEqual(['local-preset-mine'])
    expect(extractKeyValue(crlf(LF), 'local-preset-mine', 'config'))
      .toEqual(extractKeyValue(LF, 'local-preset-mine', 'config'))
    // The two reads whose loss changes a MEANING rather than a display: a
    // declaration that is not recognised, and a disabled row read as active.
    expect(parseNamedRows(crlf(LF))[0].name).toBe('@deepseek-ai/dsh-agent-preset')
    expect(parseClassifiedRows(crlf(LF))[0].disabled).toBe(false)
  })

  it('keeps reading a disabled row as disabled', () => {
    const off = LF.replace('      disabled: false', '      disabled: true')
    expect(parseClassifiedRows(crlf(off))[0].disabled).toBe(true)
    expect(parsePatchRows(crlf(off))).toEqual(parsePatchRows(off))
  })

  it('edits a CRLF file and leaves it uniformly LF, not mixed', () => {
    const out = setRowDisabled(crlf(LF), 'local-preset-mine', true)
    expect(out).not.toContain('\r')
    expect(out).toContain('      disabled: true')
    // The untouched lines survive, including the `!!js` one.
    expect(out).toContain('        id: mine')
    expect(out).toContain("            disabled: !!js process.platform === 'win32'")
  })
})

// The profile patch the launcher itself writes now carries preset declarations,
// whose `plugins` rosters reuse plugin ids. Editing by id must land on the loader
// row; an indent-blind search lands on a roster row and rewrites the preset's
// private data instead.
describe('editing by id, around a preset declaration', () => {
  const declaration = [
    '- insert:',
    '    - id: local-preset-standard',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: standard',
    '        plugins:',
    '          - id: tool-bash',
    "            name: '@deepseek-ai/dsh-tool-bash'",
    "            disabled: !!js process.platform === 'win32'",
    '',
  ].join('\n')

  it('appends a top-level override instead of editing a roster row', () => {
    expect(setRowDisabled(declaration, 'tool-bash', true)).toBe(
      `${declaration}- id: tool-bash\n  disabled: true\n`,
    )
  })

  it('removes the loader row, not a roster row of the same id', () => {
    const text = `${declaration}- id: tool-bash\n  disabled: true\n- id: keeper\n`
    expect(removeRow(text, 'tool-bash')).toBe(`${declaration}- id: keeper\n`)
  })

  it('reads a row\'s config from the loader row, not from the roster', () => {
    const text = `${declaration}- id: tool-bash\n  config:\n    timeout: 30\n- id: keeper\n`
    expect(extractKeyValue(text, 'tool-bash', 'config')).toBe('timeout: 30')
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