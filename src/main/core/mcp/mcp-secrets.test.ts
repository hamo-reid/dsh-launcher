/**
 * MCP launch secrets: save/list/get/clear, the at-rest cipher, and the two
 * guarantees the settings layer makes for a secret — never stored in plain text
 * when a cipher is available, and never included in a settings export.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportSettings, loadSettings, openDatabase } from '../settings/settings.ts'
import {
  getMcpSecret, hasMcpSecret, listMcpSecretNames, mcpSecretsEnv, setMcpSecret, setMcpSecretCipher,
} from './secrets.ts'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** A reversible fake of the injected safeStorage cipher (not real crypto). */
const fakeCipher = {
  available: () => true,
  encrypt: (plain: string) => `enc:${Buffer.from(plain).toString('base64')}`,
  decrypt: (cipherText: string) => Buffer.from(cipherText.slice('enc:'.length), 'base64').toString('utf8'),
}

function freshDb(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pm-mcp-secrets-'))
  dirs.push(dir)
  return openDatabase(join(dir, 'app.sqlite'))
}

beforeEach(() => { setMcpSecretCipher(null) })
afterEach(() => { setMcpSecretCipher(null) })

describe('mcp secrets store', () => {
  it('starts empty', async () => {
    await freshDb()
    expect(listMcpSecretNames()).toEqual([])
    expect(mcpSecretsEnv()).toEqual({})
  })

  it('saves, lists, and decrypts a secret', async () => {
    await freshDb()
    setMcpSecretCipher(fakeCipher)
    setMcpSecret('GITHUB_TOKEN', 'ghp_abc')
    setMcpSecret('OPENAI_KEY', 'sk-123')
    expect(listMcpSecretNames()).toEqual(['GITHUB_TOKEN', 'OPENAI_KEY'])
    expect(hasMcpSecret('GITHUB_TOKEN')).toBe(true)
    expect(getMcpSecret('GITHUB_TOKEN')).toBe('ghp_abc')
    expect(mcpSecretsEnv()).toEqual({ GITHUB_TOKEN: 'ghp_abc', OPENAI_KEY: 'sk-123' })
  })

  it('never stores a secret in plain text while a cipher is available', async () => {
    await freshDb()
    setMcpSecretCipher(fakeCipher)
    setMcpSecret('GITHUB_TOKEN', 'ghp_abc')
    const stored = loadSettings().mcpSecrets?.['GITHUB_TOKEN']
    expect(stored).toBeDefined()
    expect(stored).not.toBe('ghp_abc')
    expect(stored).toMatch(/^enc:/)
  })

  it('falls back to a marked plaintext when no OS cipher is available', async () => {
    await freshDb()
    setMcpSecret('GITHUB_TOKEN', 'ghp_abc')
    expect(getMcpSecret('GITHUB_TOKEN')).toBe('ghp_abc')
    expect(loadSettings().mcpSecrets?.['GITHUB_TOKEN']).toBe('plain:ghp_abc')
  })

  it('clears a secret with an empty value', async () => {
    await freshDb()
    setMcpSecretCipher(fakeCipher)
    setMcpSecret('GITHUB_TOKEN', 'ghp_abc')
    setMcpSecret('GITHUB_TOKEN', '')
    expect(listMcpSecretNames()).toEqual([])
    expect(loadSettings().mcpSecrets).toBeUndefined()
    setMcpSecret('GITHUB_TOKEN', 'ghp_abc')
    setMcpSecret('GITHUB_TOKEN', null)
    expect(listMcpSecretNames()).toEqual([])
  })

  it('rejects an invalid env-var name', async () => {
    await freshDb()
    expect(() => setMcpSecret('1BAD', 'x')).toThrow()
    expect(() => setMcpSecret('', 'x')).toThrow()
    expect(() => setMcpSecret('A B', 'x')).toThrow()
  })

  it('is dropped from a settings export', async () => {
    await freshDb()
    setMcpSecretCipher(fakeCipher)
    setMcpSecret('GITHUB_TOKEN', 'ghp_abc')
    const exported = exportSettings()
    expect(exported).not.toContain('ghp_abc')
    expect(exported).not.toContain('mcpSecrets')
  })
})
