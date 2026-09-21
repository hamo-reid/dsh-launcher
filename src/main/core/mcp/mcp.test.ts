/**
 * Behavior-locking tests for MCP row read/write inside a `cordis.patch.yml`.
 *
 * The load-bearing properties: a shipped-shape row round-trips, `!!js`
 * references stay references (a secret never becomes a literal), a hand-written
 * layer survives an edit byte-for-byte, and the duplicate-`serverName` failure
 * dsh would hit at load is named before a session starts.
 */
import { describe, expect, it } from 'vitest'
import {
  addMcpServer, diagnoseMcpServers, idTakenElsewhere, readMcpServers, removeMcpServer, renderMcpConfigBody, updateMcpServer,
} from './mcp.ts'
import type { McpIssue, McpServer, McpServerInput } from '../../../shared/types.ts'

/** The `stdio` shape from the package README. */
const STDIO_LAYER = [
  '- insert:',
  '    - id: mcp-github',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: github',
  '        transport: stdio',
  '        command: npx',
  "        args: ['-y', '@modelcontextprotocol/server-github']",
  '        env:',
  '          GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN',
  '',
].join('\n')

function server(over: Partial<McpServer>): McpServer {
  return { id: 'a', serverName: 'ok', transport: 'stdio', layer: 'profile', disabled: false, issues: [], ...over }
}

describe('readMcpServers', () => {
  it('reads the shipped stdio shape', () => {
    const [row] = readMcpServers(STDIO_LAYER, 'profile')
    expect(row.id).toBe('mcp-github')
    expect(row.serverName).toBe('github')
    expect(row.transport).toBe('stdio')
    expect(row.command).toBe('npx')
    expect(row.args).toEqual(['-y', '@modelcontextprotocol/server-github'])
    expect(row.env).toEqual([{ name: 'GITHUB_TOKEN', mode: 'env' }])
    expect(row.issues).toEqual([])
    expect(row.layer).toBe('profile')
  })

  it('keeps a non-canonical !!js expression as a raw js value', () => {
    const text = [
      '- insert:',
      '    - id: mcp-web',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: web',
      '        transport: streamable-http',
      '        url: http://localhost:3000/mcp',
      '        headers:',
      "          Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'",
      '',
    ].join('\n')
    const [row] = readMcpServers(text, 'home')
    expect(row.headers).toEqual([
      { name: 'Authorization', mode: 'js', value: '`Bearer ${process.env.MCP_TOKEN}`' },
    ])
    expect(row.transport).toBe('streamable-http')
    expect(row.url).toBe('http://localhost:3000/mcp')
  })

  it('keeps a plain literal env value', () => {
    const text = [
      '- insert:',
      '    - id: mcp-x',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: x',
      '        transport: stdio',
      '        command: run',
      '        env:',
      '          MODE: fast',
      '',
    ].join('\n')
    expect(readMcpServers(text, 'profile')[0].env).toEqual([{ name: 'MODE', mode: 'plain', value: 'fast' }])
  })

  it('reports an unreadable config instead of hiding the row', () => {
    const text = [
      '- insert:',
      '    - id: broken',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: [',
      '',
    ].join('\n')
    const [row] = readMcpServers(text, 'profile')
    expect(row.id).toBe('broken')
    expect(row.rawConfig).toBeDefined()
    expect(row.issues.map(i => i.kind)).toEqual(['unparsable-config'])
  })

  it('ignores rows that mount another package', () => {
    expect(readMcpServers("- id: x\n  name: '@x/y'\n", 'profile')).toEqual([])
  })
})

describe('add / update / remove', () => {
  const INPUT: McpServerInput = {
    id: '',
    serverName: 'github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: [{ name: 'GITHUB_TOKEN', mode: 'env' }],
  }

  it('derives a row id and round-trips through read', () => {
    const text = addMcpServer('[]\n', INPUT)
    expect(text).toContain('- id: mcp-github')
    expect(text).toContain("name: '@deepseek-ai/dsh-mcp-client'")
    expect(text).toContain('GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN')
    const [row] = readMcpServers(text, 'profile')
    expect(row.id).toBe('mcp-github')
    expect(row.serverName).toBe('github')
    expect(row.args).toEqual(['-y', '@modelcontextprotocol/server-github'])
    expect(row.env).toEqual([{ name: 'GITHUB_TOKEN', mode: 'env' }])
    expect(row.issues).toEqual([])
  })

  it('never writes a reference as a literal', () => {
    expect(addMcpServer('[]\n', INPUT)).not.toContain('GITHUB_TOKEN: ghp')
  })

  it('preserves hand-written lines when updating', () => {
    const text = addMcpServer('# keep me\n- id: other\n  disabled: true\n', INPUT)
    const updated = updateMcpServer(text, { ...INPUT, id: 'mcp-github', command: 'uvx' })
    expect(updated).toContain('# keep me')
    expect(updated).toContain('- id: other\n  disabled: true')
    expect(readMcpServers(updated, 'profile')[0].command).toBe('uvx')
  })

  it('removes the row and its emptied insert block', () => {
    const text = addMcpServer('[]\n', INPUT)
    expect(removeMcpServer(text, 'mcp-github')).toBe('')
  })

  it('renders an http row without the stdio keys', () => {
    const body = renderMcpConfigBody({
      id: 'mcp-web',
      serverName: 'web',
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
      headers: [{ name: 'Authorization', mode: 'js', value: '`Bearer ${process.env.T}`' }],
    })
    // A `:`-bearing URL is quoted so the scalar can never be misread.
    expect(body).toContain("url: 'http://localhost:3000/mcp'")
    expect(body.join('\n')).not.toContain('command')
    expect(body).toContain("  Authorization: !!js '`Bearer ${process.env.T}`'")
  })
})

describe('diagnoseMcpServers', () => {
  it('flags a duplicate serverName across layers', () => {
    const out = diagnoseMcpServers([
      server({ id: 'a', serverName: 'github', command: 'npx', layer: 'profile' }),
      server({ id: 'b', serverName: 'github', command: 'npx', layer: 'home' }),
    ])
    expect(out[0].issues.map(i => i.kind)).toEqual(['duplicate-server-name'])
    expect(out[0].issues[0].other).toEqual({ layer: 'home', id: 'b' })
  })

  it('ignores a disabled duplicate (it never loads)', () => {
    const out = diagnoseMcpServers([
      server({ id: 'a', serverName: 'github', command: 'npx' }),
      server({ id: 'b', serverName: 'github', command: 'npx', layer: 'home', disabled: true }),
    ])
    expect(out.flatMap(row => row.issues)).toEqual([])
  })

  it('an id already resolved from another layer blocks an insert', () => {
    // Rows in the TARGET layer are updated in place, so they are not a
    // collision; a row from any other layer is (dsh merges by id, so an
    // `insert:` would leave two rows of the same id in play).
    const resolved = [
      server({ id: 'mcp-github', serverName: 'github', layer: 'bundle' }),
      server({ id: 'mcp-home', serverName: 'homely', layer: 'home' }),
    ]
    expect(idTakenElsewhere(resolved, 'profile', 'mcp-github')).toBe(true)
    expect(idTakenElsewhere(resolved, 'profile', 'mcp-home')).toBe(true)
    expect(idTakenElsewhere(resolved, 'bundle', 'mcp-github')).toBe(false)
    expect(idTakenElsewhere(resolved, 'profile', 'mcp-fresh')).toBe(false)
    // A disabled row still occupies the id: the merge happens before the off
    // switch is honoured.
    expect(idTakenElsewhere([server({ id: 'mcp-off', layer: 'home', disabled: true })], 'profile', 'mcp-off')).toBe(true)
  })

  it('names a bad serverName, a missing transport and a missing endpoint', () => {
    const kinds = (over: Partial<McpServer>): McpIssue['kind'][] =>
      diagnoseMcpServers([server(over)]).flatMap(row => row.issues).map(i => i.kind)
    expect(kinds({ serverName: 'bad name', command: 'x' })).toEqual(['bad-server-name'])
    expect(kinds({ transport: '' })).toEqual(['missing-transport'])
    expect(kinds({ transport: 'websocket' })).toEqual(['unknown-transport'])
    expect(kinds({ transport: 'stdio' })).toEqual(['missing-command'])
    expect(kinds({ transport: 'streamable-http' })).toEqual(['missing-url'])
  })

  it('leaves a valid row clean', () => {
    expect(diagnoseMcpServers([server({ serverName: 'github', command: 'npx' })])[0].issues).toEqual([])
  })
})
