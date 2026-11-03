/**
 * The registry base both HTTP call sites build on.
 *
 * The setting exists to keep one invariant: choosing a version and installing it
 * must resolve against the SAME registry. Before it, `npmSearch` and
 * `fetchPackageVersions` hardcoded `registry.npmjs.org` while pnpm read the
 * user's `.npmrc`, so an air-gapped install threw before pnpm ever ran.
 *
 * A configured value reaches settings through a text field and a settings import,
 * so the fallback path is part of the contract: an unusable value warns and uses
 * the public registry rather than building a request against a nonsense scheme.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportSettings, importSettings, loadSettings, openDatabase, patchSettings } from '../settings/settings.ts'
import { PUBLIC_REGISTRY, registryBase, registryFor, SEARCH_REGISTRY } from './registry.ts'
import { normalizeSettings, splitPrefs, CURRENT_SCHEMA_VERSION } from '../settings/normalize.ts'

let root: string

const withRegistry = (url: string | undefined): string => {
  patchSettings({ registryUrl: url })
  return registryBase()
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-registry-base-'))
  await openDatabase(join(root, 'app.sqlite'))
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('registryBase', () => {
  it('uses the configured registry', () => {
    expect(withRegistry('https://registry.internal.example')).toBe('https://registry.internal.example')
  })

  it('keeps a path prefix, which some mirrors mount under one', () => {
    expect(withRegistry('https://mirror.example/npm/')).toBe('https://mirror.example/npm')
  })

  it('falls back to the public registry when unset or blank', () => {
    expect(withRegistry(undefined)).toBe(PUBLIC_REGISTRY)
    expect(withRegistry('')).toBe(PUBLIC_REGISTRY)
    expect(withRegistry('   ')).toBe(PUBLIC_REGISTRY)
  })

  it('falls back rather than building a request from an unusable value', () => {
    // `new URL` throws here, and a `file:` scheme parses — either way the answer
    // is the public registry, because silently asking the wrong host is the one
    // outcome a private deployment must never get.
    expect(withRegistry('not a url')).toBe(PUBLIC_REGISTRY)
    expect(withRegistry('file:///etc')).toBe(PUBLIC_REGISTRY)
    expect(withRegistry('ftp://mirror.example')).toBe(PUBLIC_REGISTRY)
  })
})

describe('registryFor', () => {
  const privateBase = 'https://npm.internal.example/hamo-studio/hamo-dsh/-/packages'

  const routed = (scope: string | undefined, name: string): string => {
    patchSettings({ registryUrl: privateBase, registryScope: scope })
    return registryFor(name)
  }

  it('answers for every package when no scope is set', () => {
    // The internal-mirror reading, and what every build before the scope field
    // assumed: one configured registry, all packages.
    expect(routed(undefined, '@deepseek-ai/dsh-mcp-client')).toBe(privateBase)
    expect(routed(undefined, 'lodash')).toBe(privateBase)
  })

  it('narrows the private registry to its own scope', () => {
    // The whole point of the field: a registry that does NOT proxy npmjs can
    // still be used, because everything else keeps resolving from the public one.
    expect(routed('@hamo-studio', '@hamo-studio/dsh-plugin-hamo')).toBe(privateBase)
    expect(routed('@hamo-studio', '@deepseek-ai/dsh-mcp-client')).toBe(PUBLIC_REGISTRY)
    expect(routed('@hamo-studio', 'lodash')).toBe(PUBLIC_REGISTRY)
  })

  it('matches the scope case-insensitively, with or without the at-sign', () => {
    expect(routed('hamo-studio', '@Hamo-Studio/x')).toBe(privateBase)
    expect(routed('@Hamo-Studio', '@hamo-studio/x')).toBe(privateBase)
  })

  it('falls back to the public registry when no registry is configured at all', () => {
    patchSettings({ registryUrl: undefined, registryScope: '@hamo-studio' })
    // A scope with nothing to narrow: every package is public, including the
    // scoped one — there is no private host to send it to.
    expect(registryFor('@hamo-studio/x')).toBe(PUBLIC_REGISTRY)
    expect(registryFor('lodash')).toBe(PUBLIC_REGISTRY)
  })

  it('treats an unusable scope as no scope rather than guessing a route', () => {
    // Hand-edited settings only (the settings field validates on save). An
    // unusable value must not silently mean "public for everything", which would
    // make the user's own plugins unfindable with no explanation.
    expect(routed('has space', '@hamo-studio/x')).toBe(privateBase)
    expect(routed('has space', 'lodash')).toBe(privateBase)
  })

  it('keeps search on the public catalogue whatever the source is', () => {
    // The setting governs RESOLUTION (which versions exist, and where they are
    // installed from), never DISCOVERY. A private registry is a place packages
    // are fetched from by name; routing a keyword search there meant one setting
    // silently broke the download centre's search.
    patchSettings({ registryUrl: privateBase, registryScope: '@hamo-studio' })
    expect(SEARCH_REGISTRY).toBe(PUBLIC_REGISTRY)
    patchSettings({ registryScope: undefined })
    expect(SEARCH_REGISTRY).toBe(PUBLIC_REGISTRY)
  })
})

describe('settings plumbing for registryUrl', () => {
  it('round-trips through the prefs row', () => {
    // Stored verbatim, like every other string setting: `normalizeSettings` only
    // decides whether a value is present, and trimming happens where the value is
    // used (`registryBase`) and where it is typed (`settings:setRegistryUrl`).
    expect(normalizeSettings({ registryUrl: 'https://a.example' }).registryUrl).toBe('https://a.example')
    expect(splitPrefs({ registryUrl: 'https://a.example' }).registryUrl).toBe('https://a.example')
    expect(withRegistry(' https://a.example/ ')).toBe('https://a.example')
  })

  it('drops an empty or non-string value', () => {
    expect(normalizeSettings({ registryUrl: '' }).registryUrl).toBeUndefined()
    expect(normalizeSettings({ registryUrl: '   ' }).registryUrl).toBeUndefined()
    expect(normalizeSettings({ registryUrl: 42 }).registryUrl).toBeUndefined()
  })

  it('bumps the schema version with no migration step, because the field is additive', () => {
    // The bump exists so `importSettings` refuses a newer export instead of
    // silently dropping the registry; the field needs no data-shape step.
    expect(CURRENT_SCHEMA_VERSION).toBe(3)
  })
})

describe('settings plumbing for the private source', () => {
  const privateBase = 'https://npm.internal.example/hamo-studio/hamo-dsh/-/packages'

  it('round-trips the scope through the prefs row', () => {
    expect(normalizeSettings({ registryScope: '@hamo-studio' }).registryScope).toBe('@hamo-studio')
    expect(splitPrefs({ registryScope: '@hamo-studio' }).registryScope).toBe('@hamo-studio')
    expect(normalizeSettings({ registryScope: '' }).registryScope).toBeUndefined()
  })

  it('keeps the registry token out of an export', () => {
    // Same boundary as the GitHub token and the MCP secrets: a settings backup
    // is a file that gets emailed around, and this one authorizes a registry.
    patchSettings({ registryUrl: privateBase, registryScope: '@hamo-studio', registryTokenEnc: 'enc:abc' })
    const json = exportSettings()
    expect(json).not.toContain('enc:abc')
    expect(json).not.toContain('registryTokenEnc')
    expect(json).toContain('@hamo-studio')
  })

  it('keeps this machine\'s token when an export is imported over it', () => {
    // The export has no token by construction, so importing one must not wipe the
    // value already on this machine — the same rule the GitHub token follows.
    patchSettings({ registryTokenEnc: 'enc:local' })
    importSettings(exportSettings())
    expect(loadSettings().registryTokenEnc).toBe('enc:local')
  })

  it('drops a non-string token rather than storing it', () => {
    expect(normalizeSettings({ registryTokenEnc: 42 }).registryTokenEnc).toBeUndefined()
    expect(normalizeSettings({ registryTokenEnc: '   ' }).registryTokenEnc).toBeUndefined()
  })
})