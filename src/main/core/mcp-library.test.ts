/**
 * The launcher-global MCP library: settings-backed CRUD keyed by serverName
 * (with rename), structural validation, and the drift model — an applied row
 * matches its entry when every semantic field round-trips equal, and a raw
 * (unparsable) row never matches.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, exportSettings, loadSettings, saveSettings } from './settings.ts'
import { AppError } from './errors.ts'
import {
  findMcpLibraryEntry, listMcpLibrary, mcpInputInvalid, mcpInputProblem, mcpRowMatches, removeMcpLibraryEntry, saveMcpLibraryEntry,
} from './mcp-library.ts'
import type { McpLibEntry, McpServer, McpServerInput } from '../../shared/types.ts'

let root: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-mcp-lib-'))
  await openDatabase(join(root, 'app.sqlite'))
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  // Fresh settings between tests: the library is empty at the start of each.
  saveSettings({ ...loadSettings(), mcpLibrary: undefined })
})

const stdioInput = (): McpServerInput => ({
  id: '', serverName: 'github', transport: 'stdio', command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: [{ name: 'GITHUB_TOKEN', mode: 'env', value: 'process.env.GITHUB_TOKEN' }],
})

const appliedRow = (input: McpServerInput, overrides: Partial<McpServer> = {}): McpServer => ({
  id: 'mcp-github',
  serverName: input.serverName,
  transport: input.transport,
  command: input.command,
  args: input.args,
  cwd: input.cwd,
  url: input.url,
  env: input.env,
  headers: input.headers,
  toolCallTimeoutMs: input.toolCallTimeoutMs,
  failOnStartupError: input.failOnStartupError,
  reconnect: input.reconnect,
  disabled: false,
  layer: 'profile',
  issues: [],
  ...overrides,
})

describe('mcp library store', () => {
  it('starts empty', () => {
    expect(listMcpLibrary()).toEqual([])
  })

  it('saves, finds and lists entries sorted by serverName', () => {
    saveMcpLibraryEntry(null, stdioInput())
    saveMcpLibraryEntry(null, { ...stdioInput(), serverName: 'alpha', transport: 'streamable-http', url: 'http://x/mcp', command: undefined })
    expect(listMcpLibrary().map(e => e.serverName)).toEqual(['alpha', 'github'])
    expect(findMcpLibraryEntry('github')?.input.command).toBe('npx')
  })

  it('rejects invalid entries with the offending field', () => {
    expect(mcpInputInvalid({ ...stdioInput(), serverName: 'bad name!' })).toContain('serverName')
    expect(mcpInputInvalid({ ...stdioInput(), transport: 'carrier-pigeon' as never })).toContain('transport')
    expect(mcpInputInvalid({ ...stdioInput(), command: ' ' })).toContain('command')
    expect(mcpInputInvalid({ ...stdioInput(), env: [{ name: 'A B', mode: 'plain', value: 'x' }] })).toContain('env/header')
    expect(mcpInputInvalid(stdioInput())).toBeNull()
  })

  it('save rejects an invalid input instead of storing it', () => {
    expect(() => saveMcpLibraryEntry(null, { ...stdioInput(), serverName: '' })).toThrow(/serverName/)
    expect(listMcpLibrary()).toEqual([])
  })

  it('renaming drops the old key; applied rows are the caller’s concern', () => {
    saveMcpLibraryEntry(null, stdioInput())
    saveMcpLibraryEntry('github', { ...stdioInput(), serverName: 'gh' })
    expect(findMcpLibraryEntry('github')).toBeUndefined()
    expect(findMcpLibraryEntry('gh')?.serverName).toBe('gh')
    expect(listMcpLibrary()).toHaveLength(1)
  })

  it('a create or rename landing on another entry’s name is rejected, not silently replaced', () => {
    saveMcpLibraryEntry(null, stdioInput())
    saveMcpLibraryEntry(null, { ...stdioInput(), serverName: 'alpha', transport: 'streamable-http', url: 'http://x/mcp', command: undefined })
    // Create colliding with 'github' — the original entry must survive.
    expect(() => saveMcpLibraryEntry(null, { ...stdioInput(), command: 'bunx' })).toThrow(AppError)
    // Renaming 'alpha' onto 'github' — 'alpha' must survive untouched.
    expect(() => saveMcpLibraryEntry('alpha', stdioInput())).toThrow(AppError)
    expect(findMcpLibraryEntry('github')?.input.command).toBe('npx')
    expect(findMcpLibraryEntry('alpha')?.serverName).toBe('alpha')
    // In-place save (previousServerName === serverName) is not a collision.
    saveMcpLibraryEntry('github', { ...stdioInput(), command: 'bunx' })
    expect(findMcpLibraryEntry('github')?.input.command).toBe('bunx')
    expect(listMcpLibrary()).toHaveLength(2)
  })

  it('mcpInputProblem names the error code the UI should show', () => {
    expect(mcpInputProblem({ ...stdioInput(), serverName: 'bad name!' })?.code).toBe('ext.badServerName')
    expect(mcpInputProblem({ ...stdioInput(), transport: 'carrier-pigeon' as never })?.code).toBe('ext.badTransport')
    expect(mcpInputProblem({ ...stdioInput(), command: ' ' })?.code).toBe('ext.needCommand')
    expect(mcpInputProblem({ ...stdioInput(), transport: 'streamable-http', command: undefined, url: ' ' })?.code).toBe('ext.needUrl')
    expect(mcpInputProblem({ ...stdioInput(), env: [{ name: 'A B', mode: 'plain', value: 'x' }] })?.code).toBe('ext.badEnvName')
    expect(mcpInputProblem(stdioInput())).toBeNull()
  })

  it('removes an entry and stays idempotent about unknown names', () => {
    saveMcpLibraryEntry(null, stdioInput())
    removeMcpLibraryEntry('github')
    removeMcpLibraryEntry('never-existed')
    expect(listMcpLibrary()).toEqual([])
  })

  it('the library round-trips through settings persistence and settings export', () => {
    saveMcpLibraryEntry(null, stdioInput())
    expect(loadSettings().mcpLibrary).toHaveLength(1)
    const exported = JSON.parse(exportSettings()) as { app?: { mcpLibrary?: McpLibEntry[] } }
    expect(exported.app?.mcpLibrary).toHaveLength(1) // definitions ARE exported
  })
})

describe('drift detection (mcpRowMatches)', () => {
  it('matches a freshly applied row', () => {
    const entry: McpLibEntry = { serverName: 'github', input: stdioInput(), updatedAt: '' }
    expect(mcpRowMatches(entry, appliedRow(stdioInput()))).toBe(true)
  })

  it('flags drift when a semantic field differs', () => {
    const entry: McpLibEntry = { serverName: 'github', input: stdioInput(), updatedAt: '' }
    expect(mcpRowMatches(entry, appliedRow({ ...stdioInput(), args: ['-y'] }))).toBe(false)
    expect(mcpRowMatches(entry, appliedRow({ ...stdioInput(), command: 'bunx' }))).toBe(false)
    expect(mcpRowMatches(entry, appliedRow(stdioInput(), { toolCallTimeoutMs: 5 }))).toBe(false)
    expect(mcpRowMatches(entry, appliedRow(stdioInput(), { failOnStartupError: true }))).toBe(false)
  })

  it('is order-insensitive for env/headers, value-sensitive for args', () => {
    const input = stdioInput()
    const entry: McpLibEntry = {
      serverName: 'github',
      input: {
        ...input,
        env: [
          { name: 'B_VAR', mode: 'env', value: 'process.env.B_VAR' },
          { name: 'A_VAR', mode: 'env', value: 'process.env.A_VAR' },
        ],
      },
      updatedAt: '',
    }
    const row = appliedRow({
      ...input,
      env: [
        { name: 'A_VAR', mode: 'env', value: 'process.env.A_VAR' },
        { name: 'B_VAR', mode: 'env', value: 'process.env.B_VAR' },
      ],
    })
    expect(mcpRowMatches(entry, row)).toBe(true)
    expect(mcpRowMatches(entry, appliedRow({ ...input, args: ['-y', 'x'] }))).toBe(false)
  })

  it('never matches a raw (handwritten) row', () => {
    const entry: McpLibEntry = { serverName: 'github', input: stdioInput(), updatedAt: '' }
    expect(mcpRowMatches(entry, appliedRow(stdioInput(), { rawConfig: 'command: whatever\n' }))).toBe(false)
  })

  it('flags drift when the transport itself changed', () => {
    const entry: McpLibEntry = { serverName: 'github', input: stdioInput(), updatedAt: '' }
    const httpRow = appliedRow({
      ...stdioInput(), transport: 'streamable-http', command: undefined, args: undefined,
      url: 'http://localhost/mcp',
    })
    expect(mcpRowMatches(entry, httpRow)).toBe(false)
  })
})
