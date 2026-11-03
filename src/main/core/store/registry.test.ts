/**
 * The registry table: which host answers for which package.
 *
 * One invariant underlies all of it — choosing a version and installing it must
 * resolve against the SAME registry. That is why routing is a single decision
 * here and why the pnpm configuration is generated from the same table.
 *
 * The second invariant is the one a private registry makes easy to get wrong:
 * search is discovery, not routing. A private registry is under no obligation to
 * answer `/-/v1/search`, so discovery stays on the public catalogue.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, patchSettings } from '../settings/settings.ts'
import {
  PUBLIC_REGISTRY, registries, registryFor, registryForSource,
  registrySignature, SEARCH_REGISTRY,
} from './registry.ts'

let root: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-registry-table-'))
  await openDatabase(join(root, 'app.sqlite'))
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

const PRIVATE = 'https://npm.internal.example/team/repo/-/packages'
const MIRROR = 'https://mirror.example/npm'

/** Point the machine at `list` (empty = nothing configured). */
const withRegistries = (...list: { id: string; label: string; url: string; scope?: string }[]): string =>
  (patchSettings({ registries: list.length > 0 ? list : undefined }), registryFor('anything'))

describe('registries', () => {
  it('drops an entry whose URL cannot be used, and keeps the rest', () => {
    // A hand-edited row must not break the entries that are fine, and it must not
    // reach a `fetch` either.
    withRegistries(
      { id: 'a', label: 'bad', url: 'not a url', scope: '@bad' },
      { id: 'b', label: 'good', url: PRIVATE, scope: '@good' },
    )
    expect(registries().map(entry => entry.id)).toEqual(['b'])
  })

  it('normalizes trailing slashes so one value has one spelling', () => {
    withRegistries({ id: 'a', label: 'x', url: `${PRIVATE}/` })
    expect(registries()[0]?.url).toBe(PRIVATE)
  })
})

describe('registryFor', () => {
  it('uses the public registry when nothing is configured', () => {
    expect(withRegistries()).toBe(PUBLIC_REGISTRY)
  })

  it('ignores an entry with no scope instead of letting it claim everything', () => {
    // A source owns a set of packages. One that names none would answer for every
    // package no other scope claims — the ambiguity this model removed — so it
    // resolves nothing and the public registry keeps those packages.
    expect(withRegistries({ id: 'm', label: 'mirror', url: MIRROR })).toBe(PUBLIC_REGISTRY)
    expect(registryFor('lodash')).toBe(PUBLIC_REGISTRY)
    expect(registryFor('@deepseek-ai/dsh')).toBe(PUBLIC_REGISTRY)
  })

  it('keeps a scoped entry to its own scope', () => {
    withRegistries({ id: 'p', label: 'private', url: PRIVATE, scope: '@drahamo' })
    expect(registryFor('@drahamo/hamo-app')).toBe(PRIVATE)
    expect(registryFor('@deepseek-ai/dsh')).toBe(PUBLIC_REGISTRY)
    expect(registryFor('lodash')).toBe(PUBLIC_REGISTRY)
  })

  it('leaves names no scope claims on the public registry', () => {
    withRegistries(
      { id: 'p', label: 'private', url: PRIVATE, scope: '@drahamo' },
      { id: 'm', label: 'other', url: MIRROR, scope: '@other' },
    )
    expect(registryFor('@drahamo/x')).toBe(PRIVATE)
    expect(registryFor('@other/y')).toBe(MIRROR)
    expect(registryFor('lodash')).toBe(PUBLIC_REGISTRY)
  })

  it('matches the scope as a whole segment, never as a prefix of a name', () => {
    // npm scopes are one segment: `@team` owns `@team/x`, and must not also claim
    // `@team-other/x` — a registry that answered for a neighbour's packages would
    // resolve versions the user never asked it about.
    withRegistries({ id: 'p', label: 'private', url: PRIVATE, scope: '@team' })
    expect(registryFor('@team/x')).toBe(PRIVATE)
    expect(registryFor('@team-other/x')).toBe(PUBLIC_REGISTRY)
  })

  it('does not care about the order entries were added in', () => {
    withRegistries(
      { id: 'm', label: 'other', url: MIRROR, scope: '@other' },
      { id: 'p', label: 'private', url: PRIVATE, scope: '@drahamo' },
    )
    expect(registryFor('@drahamo/x')).toBe(PRIVATE)
    expect(registryFor('@other/y')).toBe(MIRROR)
  })
})

describe('registryForSource', () => {
  it('honours an explicit public choice whatever is configured', () => {
    withRegistries({ id: 'm', label: 'mirror', url: MIRROR, scope: '@mirror' })
    expect(registryForSource('lodash', 'public')).toBe(PUBLIC_REGISTRY)
  })

  it('honours an explicit entry, even outside its scope', () => {
    // The download page lets a person ASSERT where to look. A name outside the
    // scope is not a reason to ask somewhere else — it is an answer to give back.
    withRegistries({ id: 'p', label: 'private', url: PRIVATE, scope: '@drahamo' })
    expect(registryForSource('lodash', 'reg:p')).toBe(PRIVATE)
  })

  it('refuses a choice that names no configured entry', () => {
    // Falling back to public would answer from a place the user did not choose,
    // and the mismatch would only surface at install time.
    withRegistries({ id: 'm', label: 'mirror', url: MIRROR, scope: '@mirror' })
    expect(() => registryForSource('lodash', 'reg:gone')).toThrow()
    try {
      registryForSource('lodash', 'reg:gone')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('registry.notConfigured')
    }
  })

  it('keeps `auto` on the routing', () => {
    withRegistries({ id: 'm', label: 'mirror', url: MIRROR, scope: '@mirror' })
    expect(registryForSource('@mirror/x')).toBe(MIRROR)
    expect(registryForSource('@mirror/x', 'auto')).toBe(MIRROR)
    expect(registryForSource('lodash', 'auto')).toBe(PUBLIC_REGISTRY)
  })
})

describe('defaults and discovery', () => {
  it('keeps every package outside every scope on the public registry', () => {
    withRegistries({ id: 'p', label: 'private', url: PRIVATE, scope: '@drahamo' })
    expect(registryFor('@deepseek-ai/dsh')).toBe(PUBLIC_REGISTRY)
    expect(registryFor('lodash')).toBe(PUBLIC_REGISTRY)
  })

  it('keeps search on the public catalogue whatever the table says', () => {
    // The table governs RESOLUTION (which versions exist, and where they are
    // installed from), never DISCOVERY. A private registry need not implement
    // `/-/v1/search`; routing a keyword there broke the download centre.
    withRegistries({ id: 'm', label: 'mirror', url: MIRROR, scope: '@mirror' })
    expect(SEARCH_REGISTRY).toBe(PUBLIC_REGISTRY)
  })

  it('changes the routing signature whenever the table changes', () => {
    // A cached version list belongs to a host: adding, re-scoping or renaming an
    // entry changes what `latest` means for a whole set of packages.
    withRegistries({ id: 'm', label: 'mirror', url: MIRROR, scope: '@team' })
    const before = registrySignature()
    withRegistries({ id: 'm', label: 'mirror', url: MIRROR, scope: '@other' })
    expect(registrySignature()).not.toBe(before)
    expect(registrySignature()).toBe(registrySignature())
  })
})
