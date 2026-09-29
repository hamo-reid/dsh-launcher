/**
 * Composition rows: the host's own judgement reproduced — shape first, then the
 * rows that would actually start, with `!!js` gates left undecidable instead of
 * reported as missing modules.
 */
import { describe, expect, it } from 'vitest'
import { classifyRowSpecifier, readComposition, readCompositionValue } from './rows.ts'

/** One composition text from lines (keeps the YAML readable in the test). */
const yml = (...lines: string[]): string => lines.join('\n')

describe('classifyRowSpecifier', () => {
  it('separates the four bases the host distinguishes', () => {
    expect(classifyRowSpecifier('cordis:group')).toBe('builtin')
    expect(classifyRowSpecifier('./tools/x.mjs')).toBe('preset')
    expect(classifyRowSpecifier('file:///tmp/x.mjs')).toBe('file')
    expect(classifyRowSpecifier('@deepseek-ai/dsh-tool-fs')).toBe('package')
  })

  it('treats an absolute path as a file rather than a package name', () => {
    const absolute = process.platform === 'win32' ? 'C:\\tools\\x.mjs' : '/tools/x.mjs'
    expect(classifyRowSpecifier(absolute)).toBe('file')
  })
})

describe('readComposition', () => {
  it('reads rows in composition order, labelled by id when they declare one', () => {
    const read = readComposition(yml(
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '- name: ./tools/local.mjs',
    ))
    expect(read).toEqual({
      ok: true,
      rows: [
        { label: 'row "persona"', name: '@deepseek-ai/dsh-persona', kind: 'package', skipped: false, conditional: false },
        { label: 'row 2', name: './tools/local.mjs', kind: 'preset', skipped: false, conditional: false },
      ],
    })
  })

  it('recurses into a group, labelling nested rows as the host does', () => {
    const read = readComposition(yml(
      '- id: planning',
      '  name: cordis:group',
      '  group: true',
      '  config:',
      '    - id: plan-mode',
      "      name: '@deepseek-ai/dsh-plan-mode'",
      '    - name: ./helper.mjs',
    ))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    // A row that declares an id is labelled by it wherever it sits; a row
    // without one is labelled by its position inside the group.
    expect(read.rows.map(row => [row.label, row.kind])).toEqual([
      ['row "plan-mode"', 'package'],
      ['row 1 row 2', 'preset'],
    ])
  })

  it('does not judge a row the host would not start', () => {
    const read = readComposition(yml(
      '- id: off',
      '  name: /abs/x.mjs',
      '  disabled: true',
      '- id: zero',
      '  name: /abs/x.mjs',
      '  disabled: 0',
      '- id: gated',
      '  name: /abs/x.mjs',
      "  disabled: !!js process.platform === 'win32'",
    ))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.rows.map(row => [row.label, row.skipped, row.kind])).toEqual([
      ['row "off"', true, 'file'],
      // `disabled: 0` is a row that DOES start, exactly as the loader reads it.
      ['row "zero"', false, 'file'],
      ['row "gated"', true, 'file'],
    ])
  })

  it('leaves a !!js specifier to the loader instead of calling it missing', () => {
    const read = readComposition(yml("- name: !!js someExpression()"))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.rows[0].conditional).toBe(true)
  })

  it('reports the reason a composition cannot load', () => {
    expect(readComposition('[1, 2')).toEqual({
      ok: false,
      problem: expect.stringContaining('the composition is not valid YAML'),
    })
  })

  it('rejects a document that is not a list of rows', () => {
    expect(readComposition('id: persona\n')).toEqual({
      ok: false,
      problem: 'the composition must be a top-level list of plugin rows',
    })
  })

  it('rejects a row without a plugin name', () => {
    expect(readComposition(yml('- id: persona'))).toEqual({
      ok: false,
      problem: 'row 1 names no plugin (a "name" string is required)',
    })
  })

  it('rejects a group whose config is not a list', () => {
    expect(readComposition(yml(
      '- id: planning',
      '  name: cordis:group',
      '  group: true',
      '  config: nope',
    ))).toEqual({
      ok: false,
      problem: 'group row 1 must hold a list of plugin rows',
    })
  })
})

describe('readCompositionValue', () => {
  it('judges an already-parsed list exactly as the text reader does', () => {
    const lines = [
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '- id: gate',
      "  name: '@deepseek-ai/dsh-tool-bash'",
      "  disabled: !!js process.platform === 'win32'",
    ]
    const rows = [
      { id: 'persona', name: '@deepseek-ai/dsh-persona' },
      { id: 'gate', name: '@deepseek-ai/dsh-tool-bash', disabled: 'gated' },
    ]
    const read = readCompositionValue(rows)
    expect(read.ok).toBe(true)
    expect(read).toEqual(readComposition(yml(...lines)))
    // The `!!js` value survives as a non-empty string, which is what the row
    // reader treats as "the loader decides" rather than "not disabled".
    expect(read.ok && read.rows[1].skipped).toBe(true)
  })

  it('reports the same shape problems, including nested groups', () => {
    expect(readCompositionValue({ not: 'a list' })).toEqual({
      ok: false,
      problem: 'the composition must be a top-level list of plugin rows',
    })
    expect(readCompositionValue([{ id: 'g', name: 'cordis:group', group: true, config: [{}] }])).toEqual({
      ok: false,
      problem: 'row 1 row 1 names no plugin (a "name" string is required)',
    })
  })
})
