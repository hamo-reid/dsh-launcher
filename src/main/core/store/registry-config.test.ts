/**
 * The file pnpm is pointed at, and the environment that makes it take effect.
 *
 * Two properties matter beyond "the text is right":
 * - **nothing is written without a token** — a configured registry that needs no
 *   credential is already covered by the user's own npm configuration, and
 *   replacing that file would silently drop whatever else it held;
 * - **a failure to write is not a failure to install** — the feature must
 *   degrade to "use the user's configuration", never to a broken download.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, patchSettings } from '../settings/settings.ts'
import { applyRegistryConfig, REGISTRY_NPMRC } from './registry-config.ts'
import { REGISTRY_TOKEN_ENV, setRegistryToken, setRegistryTokenCipher } from './registry-auth.ts'

const PRIVATE = 'https://npm.internal.example/hamo-studio/hamo-dsh/-/packages'

let root: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-registry-config-'))
  await openDatabase(join(root, 'app.sqlite'))
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  patchSettings({ registryUrl: undefined, registryScope: undefined, registryTokenEnc: undefined })
  setRegistryTokenCipher({
    available: () => true,
    encrypt: plain => `enc(${plain})`,
    decrypt: stored => stored.replace(/^enc\(/, '').replace(/\)$/, ''),
  })
})

describe('applyRegistryConfig', () => {
  it('writes the file and returns the environment pnpm needs', () => {
    const dir = mkdtempSync(join(root, 'ok-'))
    patchSettings({ registryUrl: PRIVATE, registryScope: '@hamo-studio' })
    setRegistryToken('secret-token')
    const env = applyRegistryConfig(dir)
    expect(env).toEqual({
      NPM_CONFIG_USERCONFIG: join(dir, REGISTRY_NPMRC),
      [REGISTRY_TOKEN_ENV]: 'secret-token',
    })
    const text = readFileSync(join(dir, REGISTRY_NPMRC), 'utf8')
    expect(text).toContain(`@hamo-studio:registry=${PRIVATE}`)
    expect(text).toContain('registry=https://registry.npmjs.org')
    expect(text).toContain(`//npm.internal.example/hamo-studio/hamo-dsh/-/packages/:_authToken=\${${REGISTRY_TOKEN_ENV}}`)
    // The structural half of the guarantee: the file names the variable, so a
    // copy of it is not a copy of the credential.
    expect(text).not.toContain('secret-token')
  })

  it('leaves the user configuration alone when no token is configured', () => {
    // A public mirror. Writing our own file would replace whatever the user has
    // configured — a corporate proxy, another registry's auth — for no gain.
    const dir = mkdtempSync(join(root, 'pub-'))
    patchSettings({ registryUrl: PRIVATE })
    expect(applyRegistryConfig(dir)).toEqual({})
    expect(existsSync(join(dir, REGISTRY_NPMRC))).toBe(false)
  })

  it('answers nothing when no registry is configured at all', () => {
    const dir = mkdtempSync(join(root, 'none-'))
    expect(applyRegistryConfig(dir)).toEqual({})
    expect(readdirSync(dir)).toEqual([])
  })

  it('is idempotent, and rewrites when the settings move on', () => {
    const dir = mkdtempSync(join(root, 'churn-'))
    const file = join(dir, REGISTRY_NPMRC)
    patchSettings({ registryUrl: PRIVATE })
    setRegistryToken('one')
    applyRegistryConfig(dir)
    const first = readFileSync(file, 'utf8')
    // Every pnpm spawn calls this; the second call must land on the same bytes
    // rather than a different-but-equivalent file.
    applyRegistryConfig(dir)
    expect(readFileSync(file, 'utf8')).toBe(first)
    // A changed scope must produce a new file, not a stale one.
    patchSettings({ registryScope: '@hamo-studio' })
    applyRegistryConfig(dir)
    expect(readFileSync(file, 'utf8')).toContain('@hamo-studio:registry=')
    expect(readFileSync(file, 'utf8')).not.toBe(first)
  })

  it('degrades to the user configuration when the file cannot be written', () => {
    // A `dir` that is a regular file, so `mkdirSync` fails: an install must still
    // run with whatever npm configuration the machine already has.
    const dir = join(mkdtempSync(join(root, 'blocked-')), 'not-a-dir')
    writeFileSync(dir, 'x', 'utf8')
    patchSettings({ registryUrl: PRIVATE })
    setRegistryToken('secret-token')
    expect(applyRegistryConfig(dir)).toEqual({})
  })

  it('does not nest the file inside a directory that already exists empty', () => {
    const dir = join(mkdtempSync(join(root, 'existing-')), 'nested')
    mkdirSync(dir)
    patchSettings({ registryUrl: PRIVATE })
    setRegistryToken('secret-token')
    applyRegistryConfig(dir)
    expect(existsSync(join(dir, REGISTRY_NPMRC))).toBe(true)
  })
})
