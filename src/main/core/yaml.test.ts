/**
 * Structure-only parsing — the escape that lets a document carrying cordis
 * `!!js` references pass validation.
 *
 * `!!js` is resolvable by `CONFIG_SCHEMA` alone, so the structure schema throws
 * `unknown scalar tag` for it. Without the escape, the very references the
 * launcher writes for MCP secrets (`NAME: !!js process.env.NAME`) would be
 * reported as malformed YAML by any validator.
 */
import { describe, expect, it } from 'vitest'
import { loadStructureOnly } from './yaml.ts'

/** The config body `core/mcp.ts` renders for a server holding a secret. */
const SECRET_CONFIG = [
  'command: bunx',
  'args:',
  '  - -y',
  '  - server-github',
  'env:',
  '  GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN',
  '',
].join('\n')

describe('loadStructureOnly', () => {
  it('skips the deep check for a document carrying a !!js reference', () => {
    expect(loadStructureOnly(SECRET_CONFIG)).toEqual({ checked: false })
  })

  it('reports a plain mapping as checked, with its structure', () => {
    expect(loadStructureOnly('command: bunx\nargs:\n  - -y\n')).toEqual({
      checked: true,
      value: { command: 'bunx', args: ['-y'] },
    })
  })

  it('does not interpret values — every scalar stays a string', () => {
    // The reason validation uses FAILSAFE rather than CONFIG_SCHEMA: a pass over
    // the document must never coerce `true` into a boolean.
    expect(loadStructureOnly('a: true\nb: 3\n')).toEqual({
      checked: true,
      value: { a: 'true', b: '3' },
    })
  })

  it('throws on malformed YAML, so a caller can report it as such', () => {
    expect(() => loadStructureOnly('a: [1,2')).toThrow()
  })
})
