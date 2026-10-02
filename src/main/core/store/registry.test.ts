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
import { openDatabase, patchSettings } from '../settings/settings.ts'
import { PUBLIC_REGISTRY, registryBase } from './registry.ts'
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