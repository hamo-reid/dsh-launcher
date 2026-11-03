/**
 * The private registry's credential: where it may travel, and where it may not.
 *
 * The security properties tested here are the reason the module exists:
 * - the value never reaches the renderer (`registryAuthState` answers two facts
 *   about it and nothing more);
 * - the `Authorization` header is only attached to the registry it belongs to,
 *   so the scope routing in `registryFor` cannot hand a private credential to a
 *   third-party host;
 * - a plaintext fallback is reported honestly rather than hidden.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, patchSettings, loadSettings } from '../settings/settings.ts'
import { exportSettings } from '../settings/settings.ts'
import {
  REGISTRY_TOKEN_ENV, privateRegistrySource, registryAuthHeader, registryAuthState,
  registryToken, setRegistryToken, setRegistryTokenCipher,
} from './registry-auth.ts'
import type { SecretCipher } from '../settings/secret-at-rest.ts'

/** Any private registry URL. The host is incidental — nothing in this module
 * branches on one. */
const PRIVATE = 'https://npm.internal.example/hamo-studio/hamo-dsh/-/packages'

/** A stand-in for Electron safeStorage: reversible and obviously not the secret. */
const fakeCipher: SecretCipher = {
  available: () => true,
  encrypt: plain => `enc(${plain})`,
  decrypt: stored => stored.replace(/^enc\(/, '').replace(/\)$/, ''),
}

const basic = (user: string, token: string): string => `Basic ${Buffer.from(`${user}:${token}`, 'utf8').toString('base64')}`

let root: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-registry-auth-'))
  await openDatabase(join(root, 'app.sqlite'))
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  patchSettings({ registryUrl: undefined, registryScope: undefined, registryTokenEnc: undefined })
  setRegistryTokenCipher(fakeCipher)
})

describe('registryToken', () => {
  it('round-trips a token through the encrypted envelope', () => {
    patchSettings({ registryUrl: PRIVATE })
    setRegistryToken('secret-token')
    expect(loadSettings().registryTokenEnc).toBe('enc(secret-token)')
    expect(registryToken()).toBe('secret-token')
  })

  it('clears the value on an empty string', () => {
    setRegistryToken('secret-token')
    setRegistryToken('')
    expect(loadSettings().registryTokenEnc).toBeUndefined()
    expect(registryToken()).toBeUndefined()
  })

  it('marks plaintext honestly when the OS keyring is unavailable', () => {
    // A portable build on a locked-down machine still has to work; saying "safe"
    // when it is not would be the one outcome this state exists to prevent.
    setRegistryTokenCipher({ available: () => false, encrypt: () => '', decrypt: () => '' })
    setRegistryToken('secret-token')
    expect(loadSettings().registryTokenEnc).toBe('plain:secret-token')
    expect(registryToken()).toBe('secret-token')
    expect(registryAuthState()).toEqual({ configured: true, encryption: 'plaintext' })
  })

  it('reports the value as absent when it cannot be decrypted', () => {
    // A keyring change or settings imported from another machine leaves a value
    // this process cannot read; the answer must be "not configured", never a
    // half-decoded string.
    setRegistryToken('secret-token')
    setRegistryTokenCipher({ available: () => true, encrypt: () => '', decrypt: () => { throw new Error('nope') } })
    expect(registryToken()).toBeUndefined()
    expect(registryAuthState()).toEqual({ configured: false, encryption: 'none' })
  })

  it('keeps the value out of an exported backup', () => {
    setRegistryToken('secret-token')
    expect(exportSettings()).not.toContain('secret-token')
  })
})

describe('registryAuthHeader', () => {
  it('sends the token the way the generated .npmrc does', () => {
    // Verified end to end in `registry-install.test.ts`: pnpm puts an
    // `_authToken` on the wire as `Bearer`. One scheme and no fallback — a
    // user-name-and-password pair is a different npm mechanism (`_auth`), and
    // guessing a user name on the caller's behalf is not this module's job.
    patchSettings({ registryUrl: PRIVATE })
    setRegistryToken('secret-token')
    expect(registryAuthHeader(`${PRIVATE}/@hamo-studio%2Fplugin`)).toEqual({
      authorization: 'Bearer secret-token',
    })
  })

  it('signs the registry base itself', () => {
    patchSettings({ registryUrl: PRIVATE })
    setRegistryToken('secret-token')
    expect(registryAuthHeader(PRIVATE)).toEqual({ authorization: 'Bearer secret-token' })
  })

  it('never signs a request to another host', () => {
    // The whole point: `registryFor` sends every out-of-scope package to the
    // public registry, and that request must not carry a private credential.
    patchSettings({ registryUrl: PRIVATE })
    setRegistryToken('secret-token')
    expect(registryAuthHeader('https://registry.npmjs.org/lodash')).toEqual({})
    // A host that merely starts with the same characters is not the same host.
    expect(registryAuthHeader('https://npm.internal.example.evil.example/x')).toEqual({})
  })

  it('answers nothing when no token is configured', () => {
    patchSettings({ registryUrl: PRIVATE })
    expect(registryAuthHeader(`${PRIVATE}/x`)).toEqual({})
  })

  it('answers nothing when no registry is configured', () => {
    setRegistryToken('secret-token')
    expect(registryAuthHeader(`${PRIVATE}/x`)).toEqual({})
  })
})

describe('privateRegistrySource', () => {
  it('names the token variable, never the token', () => {
    patchSettings({ registryUrl: PRIVATE, registryScope: '@hamo-studio' })
    setRegistryToken('secret-token')
    const source = privateRegistrySource()
    expect(source).toEqual({ registry: PRIVATE, scope: '@hamo-studio', tokenEnv: REGISTRY_TOKEN_ENV })
    expect(JSON.stringify(source)).not.toContain('secret-token')
  })

  it('describes a scope-less source, which means "everything goes here"', () => {
    patchSettings({ registryUrl: PRIVATE })
    setRegistryToken('secret-token')
    expect(privateRegistrySource()).toEqual({ registry: PRIVATE, tokenEnv: REGISTRY_TOKEN_ENV })
  })

  it('asks for no auth line when there is no token', () => {
    // A public mirror: writing an auth line that points at an unset variable
    // would fail every install with a 401.
    patchSettings({ registryUrl: PRIVATE })
    expect(privateRegistrySource()).toEqual({ registry: PRIVATE })
  })

  it('answers undefined when nothing is configured at all', () => {
    expect(privateRegistrySource()).toBeUndefined()
  })
})
