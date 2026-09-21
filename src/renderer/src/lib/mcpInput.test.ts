/**
 * `mcpInput.ts` codec: args bridging, normalization, JSON projection and
 * per-branch parse problems. The fixed-point test is the load-bearing one —
 * what the JSON pane shows must equal what `submit()` would send.
 */
import { describe, expect, it } from 'vitest'
import {
  argsFromText, argsToText, blankMcpInput, fromServer, jsonToMcpInput,
  mcpInputToJson, normalizeInput, type McpJsonProblem, type McpJsonResult,
} from './mcpInput.ts'
import type { McpServer, McpServerInput } from '../../../shared/types.ts'

const stdioInput = (): McpServerInput => ({
  id: '',
  serverName: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: [
    { name: 'GITHUB_TOKEN', mode: 'env' },
    { name: 'LOG_LEVEL', mode: 'plain', value: 'debug' },
  ],
  cwd: '',
})

const httpInput = (): McpServerInput => ({
  id: 'mcp-linear',
  serverName: 'linear',
  transport: 'streamable-http',
  url: 'https://mcp.linear.app/mcp',
  headers: [{ name: 'Authorization', mode: 'js', value: '`Bearer ${process.env.LINEAR_TOKEN}`' }],
  toolCallTimeoutMs: 60000,
  failOnStartupError: false,
  reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
  disabled: false,
})

function server(over: Partial<McpServer> = {}): McpServer {
  return {
    id: 'mcp-github', serverName: 'github', transport: 'stdio', command: 'npx',
    args: ['-y'], env: [], layer: 'profile', disabled: false, issues: [], ...over,
  }
}

function problemOf(text: string): McpJsonProblem {
  const result = jsonToMcpInput(text) as McpJsonResult & { problem?: McpJsonProblem }
  if (result.problem === undefined) throw new Error(`expected a problem for: ${text}`)
  return result.problem
}

describe('blankMcpInput / fromServer', () => {
  it('blanks a new server', () => {
    expect(blankMcpInput()).toEqual(
      { id: '', serverName: '', transport: 'stdio', command: '', args: [], env: [], cwd: '' },
    )
  })

  it('maps every row field, filling gaps with blanks', () => {
    expect(fromServer(server())).toMatchObject({
      id: 'mcp-github', serverName: 'github', transport: 'stdio',
      command: 'npx', args: ['-y'], cwd: '', url: '', headers: [],
    })
    expect(fromServer(server()).disabled).toBeUndefined()
  })

  it('carries a disabled row through, so saving does not re-enable it', () => {
    expect(fromServer(server({ disabled: true })).disabled).toBe(true)
  })

  it('folds an unknown transport into stdio', () => {
    expect(fromServer(server({ transport: 'carrier-pigeon' })).transport).toBe('stdio')
  })
})

describe('args bridging', () => {
  it('round-trips one argument per line', () => {
    expect(argsToText(['-y', 'pkg'])).toBe('-y\npkg')
    expect(argsFromText('-y\npkg')).toEqual(['-y', 'pkg'])
  })

  it('drops blank lines and trims whitespace', () => {
    expect(argsFromText('  -y  \n\n  pkg\n')).toEqual(['-y', 'pkg'])
    expect(argsFromText('')).toEqual([])
  })

  it('handles CRLF', () => {
    expect(argsFromText('-y\r\npkg\r\n')).toEqual(['-y', 'pkg'])
  })
})

describe('normalizeInput', () => {
  it('takes args from the text field and drops blank env/headers rows', () => {
    const out = normalizeInput(
      { ...stdioInput(), env: [...(stdioInput().env ?? []), { name: '', mode: 'env' as const }] },
      '-y\npkg',
    )
    expect(out.args).toEqual(['-y', 'pkg'])
    expect(out.env?.map(entry => entry.name)).toEqual(['GITHUB_TOKEN', 'LOG_LEVEL'])
  })

  it('leaves absent env/headers absent', () => {
    const out = normalizeInput({ id: '', serverName: 'a', transport: 'stdio' }, '')
    expect(out.env).toBeUndefined()
    expect(out.headers).toBeUndefined()
  })
})

describe('form <-> JSON fixed point', () => {
  const cases: Array<[string, McpServerInput, string]> = [
    ['stdio', stdioInput(), '-y\n@modelcontextprotocol/server-github'],
    ['http', httpInput(), ''],
    ['minimal', { id: '', serverName: 'a', transport: 'stdio' }, ''],
  ]

  for (const [name, input, argsText] of cases) {
    it(`round-trips a ${name} document`, () => {
      const json = mcpInputToJson(input, argsText)
      const back = jsonToMcpInput(json)
      if (!('input' in back)) throw new Error(`expected success: ${JSON.stringify(back)}`)
      expect(normalizeInput(back.input, back.argsText)).toEqual(normalizeInput(input, argsText))
    })
  }

  it('never shows a blank-name row the submit would silently drop', () => {
    const json = mcpInputToJson(
      { ...stdioInput(), env: [...(stdioInput().env ?? []), { name: '', mode: 'env' as const }] },
      '-y',
    )
    expect(json).not.toContain('"name": ""')
    const back = jsonToMcpInput(json)
    if (!('input' in back)) throw new Error('expected success')
    expect(back.input.env?.map(entry => entry.name)).toEqual(['GITHUB_TOKEN', 'LOG_LEVEL'])
  })

  it('keeps an args entry containing a newline on parse (re-projection re-splits it)', () => {
    const back = jsonToMcpInput('{"serverName":"a","transport":"stdio","args":["x\\ny"]}')
    if (!('input' in back)) throw new Error('expected success')
    // The newline survives the parse…
    expect(back.input.args).toEqual(['x\ny'])
    // …but the next projection cuts it per line. Known, harmless asymmetry.
    expect(argsFromText(back.argsText)).toEqual(['x', 'y'])
  })
})

describe('jsonToMcpInput problems', () => {
  it('reports unparsable JSON with the parser message', () => {
    const problem = problemOf('{')
    expect(problem.kind).toBe('parse')
    if (problem.kind === 'parse') expect(problem.message.length).toBeGreaterThan(0)
  })

  it('rejects a non-object top level', () => {
    expect(problemOf('[]')).toEqual({ kind: 'notObject' })
    expect(problemOf('null')).toEqual({ kind: 'notObject' })
    expect(problemOf('"x"')).toEqual({ kind: 'notObject' })
  })

  it('rejects unknown top-level keys instead of dropping them', () => {
    expect(problemOf('{"serverName":"a","transport":"stdio","nope":1}'))
      .toEqual({ kind: 'unknown', keys: ['nope'] })
  })

  it('rejects wrong field types', () => {
    expect(problemOf('{"serverName":1}'))
      .toEqual({ kind: 'field', field: 'serverName', expected: 'string' })
    expect(problemOf('{"transport":"sse"}'))
      .toEqual({ kind: 'field', field: 'transport', expected: `'stdio' | 'streamable-http'` })
    expect(problemOf('{"args":"-y"}'))
      .toEqual({ kind: 'field', field: 'args', expected: 'string[]' })
    expect(problemOf('{"args":["-y",1]}'))
      .toEqual({ kind: 'field', field: 'args', expected: 'string[]' })
    expect(problemOf('{"toolCallTimeoutMs":"60"}'))
      .toEqual({ kind: 'field', field: 'toolCallTimeoutMs', expected: 'number' })
    expect(problemOf('{"disabled":"yes"}'))
      .toEqual({ kind: 'field', field: 'disabled', expected: 'boolean' })
  })

  it('rejects malformed env entries', () => {
    expect(problemOf('{"env":[{"name":"A","mode":"weird"}]}'))
      .toEqual({ kind: 'field', field: 'env[0].mode', expected: `'plain' | 'env' | 'js'` })
    expect(problemOf('{"env":[{"mode":"plain"}]}'))
      .toEqual({ kind: 'field', field: 'env[0].name', expected: 'string' })
    expect(problemOf('{"headers":"x"}'))
      .toEqual({ kind: 'field', field: 'headers', expected: 'McpKV[]' })
  })

  it('rejects unknown keys inside reconnect', () => {
    expect(problemOf('{"reconnect":{"nope":1}}'))
      .toEqual({ kind: 'unknown', keys: ['reconnect.nope'] })
    expect(problemOf('{"reconnect":{"enabled":"yes"}}'))
      .toEqual({ kind: 'field', field: 'reconnect.enabled', expected: 'boolean' })
    expect(problemOf('{"reconnect":[]}'))
      .toEqual({ kind: 'field', field: 'reconnect', expected: 'object' })
  })

  it('defaults the required fields of a minimal document and keeps optionals absent', () => {
    const back = jsonToMcpInput('{"serverName":"a","transport":"stdio"}')
    if (!('input' in back)) throw new Error('expected success')
    expect(back.input).toEqual({ id: '', serverName: 'a', transport: 'stdio' })
    expect(Object.values(back.input).every(value => value !== undefined)).toBe(true)
  })

  it('accepts the three KV modes and optional values', () => {
    const back = jsonToMcpInput(
      '{"serverName":"a","transport":"stdio","env":[{"name":"A","mode":"env"},' +
      '{"name":"B","mode":"plain","value":"x"},{"name":"C","mode":"js","value":"f()"}]}',
    )
    if (!('input' in back)) throw new Error('expected success')
    expect(back.input.env).toEqual([
      { name: 'A', mode: 'env' },
      { name: 'B', mode: 'plain', value: 'x' },
      { name: 'C', mode: 'js', value: 'f()' },
    ])
  })
})
