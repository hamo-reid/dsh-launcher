/**
 * Registry credentials: where one may travel, and where it may not.
 *
 * The security properties tested here are the reason the module exists:
 * - no token value reaches the renderer (`registryEntryViews` answers "is there
 *   one, and how is it protected" and nothing more);
 * - a token is attached only to the URLs its own entry owns, so the routing in
 *   `registryFor` cannot hand a private credential to a third-party host;
 * - one entry's token is never sent to another entry's host, which is the whole
 *   reason tokens are per entry rather than global.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportSettings, importSettings, openDatabase, patchSettings } from '../settings/settings.ts'
import {
  privateSources, registryAuthHeader, registryEntryViews, registryTokenEnv, registryTokenEnvName,
  setRegistryToken, setRegistryTokenCipher,
} from './registry-auth.ts'
import type { SecretCipher } from '../settings/secret-at-rest.ts'

/** Any private registry URLs. The hosts are incidental — nothing in this module
 * branches on one. */
const PRIVATE = 'https://npm.internal.example/team/repo/-/packages'
const OTHER = 'https://npm.other.example/registry'

/** A stand-in for Electron safeStorage: reversible and obviously not the secret. */
const fakeCipher: SecretCipher = {
  available: () => true,
  encrypt: plain => `enc(${plain})`,
  decrypt: stored => stored.replace(/^enc\(/, '').replace(/\)$/, ''),
}

let root: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-registry-auth-'))
  await openDatabase(join(root, 'app.sqlite'))
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  patchSettings({ registries: undefined })
  setRegistryTokenCipher(fakeCipher)
})

/** Two entries: one scoped, one the fallback. The shape a real machine has. */
const twoEntries = (): void => {
  patchSettings({
    registries: [
      { id: 'team', label: 'team', url: PRIVATE, scope: '@team' },
      { id: 'mirror', label: 'mirror', url: OTHER, scope: '@mirror' },
    ],
  })
}

describe('registryEntryViews', () => {
  it('reports the facts and never the value', () => {
    twoEntries()
    setRegistryToken('team', 'secret-token')
    const [team] = registryEntryViews()
    expect(team).toEqual({
      id: 'team', label: 'team', url: PRIVATE, scope: '@team', hasToken: true, encryption: 'safe',
    })
    expect(JSON.stringify(registryEntryViews())).not.toContain('secret-token')
  })

  it('says plaintext when no cipher is available rather than pretending', () => {
    twoEntries()
    setRegistryTokenCipher({
      available: () => false,
      encrypt: plain => `plain(${plain})`,
      decrypt: stored => stored.replace(/^plain\(/, '').replace(/\)$/, ''),
    })
    setRegistryToken('team', 'secret-token')
    expect(registryEntryViews()[0]?.encryption).toBe('plaintext')
    setRegistryTokenCipher(fakeCipher)
  })

  it('reports "none" when nothing is saved', () => {
    twoEntries()
    expect(registryEntryViews().every(entry => entry.encryption === 'none')).toBe(true)
  })
})

describe('setRegistryToken', () => {
  it('touches only the entry it names', () => {
    twoEntries()
    setRegistryToken('team', 'a')
    expect(registryEntryViews().map(entry => entry.hasToken)).toEqual([true, false])
    setRegistryToken('mirror', 'b')
    expect(registryEntryViews().map(entry => entry.hasToken)).toEqual([true, true])
  })

  it('clears with an empty value', () => {
    twoEntries()
    setRegistryToken('team', 'a')
    setRegistryToken('team', '')
    expect(registryEntryViews()[0]?.hasToken).toBe(false)
  })

  it('is idempotent for an unknown id', () => {
    twoEntries()
    expect(setRegistryToken('nope', 'a').every(entry => !entry.hasToken)).toBe(true)
  })
})

describe('registryAuthHeader', () => {
  it('sends the token the way the generated .npmrc does — Bearer only', () => {
    // Verified end to end in `registry-install.test.ts`: pnpm puts an
    // `_authToken` on the wire as `Bearer`. One scheme and no fallback: a user
    // name and password pair is a different npm mechanism (`_auth`).
    twoEntries()
    setRegistryToken('team', 'secret-token')
    expect(registryAuthHeader(`${PRIVATE}/@team%2Fplugin`)).toEqual({
      authorization: 'Bearer secret-token',
    })
  })

  it('never sends one entry\'s token to another entry\'s host', () => {
    twoEntries()
    setRegistryToken('team', 'team-token')
    expect(registryAuthHeader(`${OTHER}/lodash`)).toEqual({})
    expect(registryAuthHeader('https://registry.npmjs.org/lodash')).toEqual({})
    // A host that merely starts with the same characters is not the same host.
    expect(registryAuthHeader('https://npm.internal.example.evil.example/x')).toEqual({})
  })

  it('prefers the narrower base when one URL sits inside another', () => {
    // A registry mounted under a path prefix is a different owner than the host.
    patchSettings({
      registries: [
        { id: 'host', label: 'host', url: 'https://npm.internal.example' },
        { id: 'repo', label: 'repo', url: PRIVATE, scope: '@team' },
      ],
    })
    setRegistryToken('host', 'host-token')
    setRegistryToken('repo', 'repo-token')
    expect(registryAuthHeader(`${PRIVATE}/@team%2Fplugin`).authorization).toBe('Bearer repo-token')
    expect(registryAuthHeader('https://npm.internal.example/elsewhere').authorization).toBe('Bearer host-token')
  })

  it('answers nothing when the owning entry has no token', () => {
    twoEntries()
    expect(registryAuthHeader(`${PRIVATE}/x`)).toEqual({})
  })
})

describe('privateSources and the pnpm environment', () => {
  it('describes every entry, naming a token variable only where there is a token', () => {
    twoEntries()
    setRegistryToken('team', 'secret-token')
    expect(privateSources()).toEqual([
      { registry: PRIVATE, scope: '@team', tokenEnv: registryTokenEnvName('team') },
      { registry: OTHER, scope: '@mirror' },
    ])
  })

  it('hands each token to the child under its own name', () => {
    twoEntries()
    setRegistryToken('team', 'a')
    setRegistryToken('mirror', 'b')
    expect(registryTokenEnv()).toEqual({
      [registryTokenEnvName('team')]: 'a',
      [registryTokenEnvName('mirror')]: 'b',
    })
  })

  it('derives a usable variable name from any id', () => {
    expect(registryTokenEnvName('team')).toMatch(/^PM_REGISTRY_TOKEN_[A-Z0-9_]+$/)
    expect(registryTokenEnvName('a-b.c')).toBe('PM_REGISTRY_TOKEN_A_B_C')
  })
})

describe('export', () => {
  it('never carries a token, and an import keeps this machine\'s', () => {
    twoEntries()
    setRegistryToken('team', 'secret-token')
    const json = exportSettings()
    expect(json).not.toContain('secret-token')
    expect(JSON.parse(json).app.registries).toHaveLength(2)

    // Import a list that still names the entry: the local token must survive,
    // because a backup is not a credential and the credential was never in it.
    importSettings(json)
    expect(registryEntryViews().find(entry => entry.id === 'team')?.hasToken).toBe(true)
  })
})
