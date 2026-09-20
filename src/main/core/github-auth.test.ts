/**
 * GitHub API authentication: header construction, token resolution (saved
 * setting → environment), the at-rest cipher, and rate-limit tracking.
 *
 * The token itself is a secret, so these tests also pin the two guarantees the
 * settings layer makes: it is never stored in plain text (when a cipher is
 * available) and never included in a settings export.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportSettings, importSettings, loadSettings, openDatabase, patchSettings } from './settings.ts'
import {
  githubAuthHeaders, githubAuthState, initGithubAuth, noteGithubResponse, resetGithubRateLimit, setGithubToken, setTokenCipher,
} from './github-auth.ts'

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** A reversible fake of the injected safeStorage cipher (not real crypto). */
const fakeCipher = {
  available: () => true,
  encrypt: (plain: string) => `enc:${Buffer.from(plain).toString('base64')}`,
  decrypt: (cipherText: string) => Buffer.from(cipherText.slice('enc:'.length), 'base64').toString('utf8'),
}

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-github-auth-'))
  dirs.push(dir)
  return join(dir, 'app.sqlite')
}

beforeEach(() => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  setTokenCipher(null)
  resetGithubRateLimit()
})
afterEach(() => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  setTokenCipher(null)
  resetGithubRateLimit()
})

describe('header construction', () => {
  it('sends no Authorization header when unauthenticated', async () => {
    await openDatabase(tmpFile())
    initGithubAuth()
    expect(githubAuthState()).toMatchObject({ authenticated: false, source: 'none' })
    const headers = githubAuthHeaders()
    expect(headers.authorization).toBeUndefined()
    expect(headers.accept).toBe('application/vnd.github+json')
    expect(headers['user-agent']).toBe('dsh-launcher')
  })

  it('adds a Bearer token and merges extra headers', async () => {
    await openDatabase(tmpFile())
    process.env.GH_TOKEN = 'env-token'
    initGithubAuth()
    const headers = githubAuthHeaders({ 'x-extra': '1' })
    expect(headers.authorization).toBe('Bearer env-token')
    expect(headers['x-extra']).toBe('1')
  })
})

describe('token resolution', () => {
  it('falls back to GH_TOKEN when nothing is saved', async () => {
    await openDatabase(tmpFile())
    process.env.GH_TOKEN = 'env-token'
    initGithubAuth()
    expect(githubAuthState()).toMatchObject({ authenticated: true, source: 'env', encryption: 'none' })
  })

  it('prefers GITHUB_TOKEN over an empty GH_TOKEN', async () => {
    await openDatabase(tmpFile())
    process.env.GH_TOKEN = '   '
    process.env.GITHUB_TOKEN = 'fallback'
    initGithubAuth()
    expect(githubAuthHeaders().authorization).toBe('Bearer fallback')
  })
})

describe('at-rest storage', () => {
  it('stores the saved token encrypted, never in plain text', async () => {
    await openDatabase(tmpFile())
    setTokenCipher(fakeCipher)
    setGithubToken('ghp_secret')
    expect(githubAuthState()).toMatchObject({ authenticated: true, source: 'settings', encryption: 'safe' })
    expect(githubAuthHeaders().authorization).toBe('Bearer ghp_secret')
    const stored = loadSettings().githubTokenEnc
    expect(stored).toBe(fakeCipher.encrypt('ghp_secret'))
    expect(stored).not.toContain('ghp_secret')
  })

  it('round-trips the saved token across a reload', async () => {
    const file = tmpFile()
    await openDatabase(file)
    setTokenCipher(fakeCipher)
    setGithubToken('ghp_abc')
    await openDatabase(file) // reload from disk
    setTokenCipher(fakeCipher)
    initGithubAuth()
    expect(githubAuthState()).toMatchObject({ authenticated: true, source: 'settings' })
    expect(githubAuthHeaders().authorization).toBe('Bearer ghp_abc')
  })

  it('marks the store plaintext when no cipher is available', async () => {
    await openDatabase(tmpFile())
    setTokenCipher({ available: () => false, encrypt: () => '', decrypt: () => '' })
    setGithubToken('ghp_plain')
    expect(githubAuthState().encryption).toBe('plaintext')
    expect(loadSettings().githubTokenEnc).toBe('plain:ghp_plain')
  })

  it('clearing reverts to the environment token', async () => {
    await openDatabase(tmpFile())
    setTokenCipher(fakeCipher)
    process.env.GH_TOKEN = 'env-token'
    setGithubToken('ghp_x')
    expect(githubAuthState().source).toBe('settings')
    setGithubToken('')
    expect(githubAuthState()).toMatchObject({ authenticated: true, source: 'env' })
    expect(loadSettings().githubTokenEnc).toBeUndefined()
  })
})

describe('rate-limit tracking', () => {
  const res = (status: number, remaining: string | null) => ({
    status,
    headers: { get: (name: string) => (name === 'x-ratelimit-remaining' ? remaining : null) },
  })

  it('records a 403/429 with no quota left until reset', () => {
    expect(noteGithubResponse(res(403, '0'))).toBe(true)
    expect(githubAuthState().rateLimited).toBe(true)
    resetGithubRateLimit()
    expect(githubAuthState().rateLimited).toBe(false)
    expect(noteGithubResponse(res(429, '0'))).toBe(true)
    expect(githubAuthState().rateLimited).toBe(true)
  })

  it('does not flag an ordinary 403 (private repo) or a 404', () => {
    expect(noteGithubResponse(res(403, '42'))).toBe(false)
    expect(noteGithubResponse(res(404, null))).toBe(false)
    expect(githubAuthState().rateLimited).toBe(false)
  })
})

describe('settings export / import', () => {
  it('never exports the token but keeps it across an import', async () => {
    await openDatabase(tmpFile())
    setTokenCipher(fakeCipher)
    setGithubToken('ghp_keep')
    patchSettings({ pluginDir: '/store' })

    const json = exportSettings()
    expect(json).not.toContain('githubTokenEnc')
    expect(json).not.toContain('ghp_keep')

    importSettings(json)
    expect(loadSettings().pluginDir).toBe('/store')
    expect(loadSettings().githubTokenEnc).toBe(fakeCipher.encrypt('ghp_keep'))
  })
})
