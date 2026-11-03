/**
 * The rules that turn one private source into npm's own configuration.
 *
 * The module exists because two things must never be guessed at:
 * - **which** packages leave the public registry (a scope, or all of them), and
 * - **where** the token lives (an environment variable, never the file).
 *
 * The second is a security property, not a convenience: an `.npmrc` holding a
 * literal token would be copied into every archive that used the source.
 */
import { describe, expect, it } from 'vitest'
import {
  authKeyFor, buildNpmrc, matchesScope, normalizeScope, parseRegistry, registryEnv, scopeOfName,
} from './npmrc.ts'

const CNB = 'https://npm.cnb.cool/hamo-studio/hamo-dsh/-/packages'

describe('parseRegistry', () => {
  it('drops trailing slashes so one registry has one spelling', () => {
    expect(parseRegistry(`${CNB}/`)).toBe(CNB)
    expect(parseRegistry(`${CNB}///`)).toBe(CNB)
  })

  it('keeps the path a registry is mounted under', () => {
    // CNB artifact repositories live under `<org>/<repo>/-/packages/`; collapsing
    // that to the host would ask the wrong endpoint for every package.
    expect(parseRegistry(CNB)).toBe(CNB)
    expect(parseRegistry('https://mirror.example/npm')).toBe('https://mirror.example/npm')
  })

  it('trims what a text field hands over', () => {
    expect(parseRegistry(`  ${CNB}  `)).toBe(CNB)
  })

  it('answers undefined for anything unusable, rather than a half-value', () => {
    expect(parseRegistry(undefined)).toBeUndefined()
    expect(parseRegistry('')).toBeUndefined()
    expect(parseRegistry('   ')).toBeUndefined()
    expect(parseRegistry('not a url')).toBeUndefined()
    expect(parseRegistry('file:///etc')).toBeUndefined()
    expect(parseRegistry('ftp://mirror.example')).toBeUndefined()
  })
})

describe('normalizeScope / scopeOfName', () => {
  it('accepts the scope with or without the at-sign', () => {
    expect(normalizeScope('hamo-studio')).toBe('@hamo-studio')
    expect(normalizeScope('@hamo-studio')).toBe('@hamo-studio')
    expect(normalizeScope('  @hamo-studio  ')).toBe('@hamo-studio')
  })

  it('refuses a scope that could not be half of a package name', () => {
    expect(normalizeScope('')).toBeUndefined()
    expect(normalizeScope('@')).toBeUndefined()
    expect(normalizeScope('has space')).toBeUndefined()
    expect(normalizeScope('has/slash')).toBeUndefined()
  })

  it('reads the scope off a package name', () => {
    expect(scopeOfName('@hamo-studio/dsh-plugin-hamo')).toBe('@hamo-studio')
    expect(scopeOfName('plain-name')).toBeUndefined()
    expect(scopeOfName('@only-a-scope')).toBeUndefined()
  })

  it('compares scopes case-insensitively, because a registry host may not', () => {
    expect(matchesScope('@Hamo-Studio/x', '@hamo-studio')).toBe(true)
    expect(matchesScope('@hamo-studio/x', 'hamo-studio')).toBe(true)
    expect(matchesScope('@other/x', '@hamo-studio')).toBe(false)
    expect(matchesScope('unscoped', '@hamo-studio')).toBe(false)
  })
})

describe('authKeyFor', () => {
  it('keeps the path and always ends in a slash', () => {
    // The path is the whole point: `//host/` would offer the token to every
    // repository on the same host.
    expect(authKeyFor(CNB)).toBe('//npm.cnb.cool/hamo-studio/hamo-dsh/-/packages/')
    expect(authKeyFor(`${CNB}/`)).toBe('//npm.cnb.cool/hamo-studio/hamo-dsh/-/packages/')
  })

  it('keeps a port, because a self-hosted registry usually has one', () => {
    expect(authKeyFor('http://127.0.0.1:4873')).toBe('//127.0.0.1:4873/')
  })

  it('answers undefined for a value no URL can be built from', () => {
    expect(authKeyFor('nonsense')).toBeUndefined()
    expect(authKeyFor('file:///etc')).toBeUndefined()
  })
})

describe('buildNpmrc', () => {
  const opts = { defaultRegistry: 'https://registry.npmjs.org' }

  it('sends everything to the private source when no scope is set', () => {
    // The internal-mirror case: one registry that also proxies the public one.
    const text = buildNpmrc({ registry: CNB }, opts)
    expect(text).toBe(`registry=${CNB}\n`)
  })

  it('redirects only the scope, and pins the default explicitly', () => {
    // Pinning the default matters: the generated file REPLACES the user config
    // pnpm would otherwise read, so leaving it out would change where every
    // other package resolves from.
    const text = buildNpmrc({ registry: CNB, scope: '@hamo-studio' }, opts)
    expect(text).toBe(
      `registry=https://registry.npmjs.org\n@hamo-studio:registry=${CNB}\n`,
    )
  })

  it('names the token variable instead of writing a token', () => {
    const text = buildNpmrc({ registry: CNB, scope: '@hamo-studio', tokenEnv: 'PM_REGISTRY_TOKEN' }, opts)
    expect(text).toBe(
      'registry=https://registry.npmjs.org\n' +
      `@hamo-studio:registry=${CNB}\n` +
      '//npm.cnb.cool/hamo-studio/hamo-dsh/-/packages/:_authToken=${PM_REGISTRY_TOKEN}\n' +
      'always-auth=true\n',
    )
    // The structural half of the guarantee: nothing token-shaped can be in here,
    // because no token is ever passed to this function.
    expect(text).not.toMatch(/:_authToken=[^$\n]/)
  })

  it('omits the auth lines when the source needs no token', () => {
    const text = buildNpmrc({ registry: CNB }, opts) ?? ''
    expect(text).not.toContain('_authToken')
    expect(text).not.toContain('always-auth')
  })

  it('refuses to describe a source it cannot authenticate to', () => {
    // A bad variable name is a configuration mistake. Emitting the file without
    // the auth line would turn it into a 401 that looks like an expired token.
    expect(buildNpmrc({ registry: CNB, tokenEnv: 'bad-name' }, opts)).toBeUndefined()
    expect(buildNpmrc({ registry: 'nonsense', tokenEnv: 'PM_TOKEN' }, opts)).toBeUndefined()
  })
})

describe('registryEnv', () => {
  it('points pnpm at the generated file and supplies the token', () => {
    expect(registryEnv({ configPath: 'C:/data/npmrc', tokenEnv: 'PM_REGISTRY_TOKEN', token: 'secret' })).toEqual({
      NPM_CONFIG_USERCONFIG: 'C:/data/npmrc',
      PM_REGISTRY_TOKEN: 'secret',
    })
  })

  it('does not export a token it does not have', () => {
    // A blank value must clear the variable rather than export an empty one, so
    // a stale token cannot authorize a request the current settings do not.
    expect(registryEnv({ configPath: 'C:/data/npmrc', tokenEnv: 'PM_REGISTRY_TOKEN', token: '' })).toEqual({
      NPM_CONFIG_USERCONFIG: 'C:/data/npmrc',
    })
    expect(registryEnv({ configPath: 'C:/data/npmrc' })).toEqual({ NPM_CONFIG_USERCONFIG: 'C:/data/npmrc' })
  })

  it('ignores a variable name the child environment could not carry', () => {
    expect(registryEnv({ configPath: 'p', tokenEnv: 'bad-name', token: 'secret' })).toEqual({ NPM_CONFIG_USERCONFIG: 'p' })
  })
})
