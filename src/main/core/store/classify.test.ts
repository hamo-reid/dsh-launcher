/**
 * Plugin classification + update-detection pure logic: origin/kind derivation,
 * the update comparator, per-row update info, and catalog annotations.
 */
import { describe, expect, it } from 'vitest'
import { kindOf, originOf, orderProvenances, provenanceOf } from './overview.ts'
import { isUpdateAvailable, repoFromSpec, toUpdateInfo } from './updates.ts'
import { annotationsFor } from './market.ts'
import type { MarketCatalog, PluginSource } from '../../../shared/types.ts'

describe('originOf', () => {
  const cases: [PluginSource[], ReturnType<typeof originOf>][] = [
    [['store'], 'unknown'],
    [['dsh'], 'unknown'],
    [['github'], 'github'],
    [['local'], 'local'],
    [['github', 'npm'], 'npm'],
    [['local', 'npm', 'github'], 'npm'],
  ]
  it.each(cases)('%j → %s', (sources, expected) => {
    expect(originOf(sources)).toBe(expected)
  })
})

describe('kindOf', () => {
  it('classifies a used, non-store plugin as a template', () => {
    expect(kindOf(true, false, false)).toBe('template')
  })
  it('classifies an unused store plugin as store-only', () => {
    expect(kindOf(false, true, false)).toBe('store-only')
  })
  it('classifies a used store plugin in a bundle layer as a bundle', () => {
    expect(kindOf(true, true, true)).toBe('bundle')
  })
  it('classifies a used store plugin not in a layer as a dependency', () => {
    expect(kindOf(true, true, false)).toBe('dependency')
  })
})

describe('provenanceOf', () => {
  it('store wins over every other signal', () => {
    expect(provenanceOf({ inStore: true, fromAnchor: true, subBundle: true, localLink: true })).toBe('store')
  })
  it('falls back official → sub-bundle → local-link → external', () => {
    expect(provenanceOf({ inStore: false, fromAnchor: true, subBundle: true, localLink: true })).toBe('official')
    expect(provenanceOf({ inStore: false, fromAnchor: false, subBundle: true, localLink: true })).toBe('sub-bundle')
    expect(provenanceOf({ inStore: false, fromAnchor: false, subBundle: false, localLink: true })).toBe('local-link')
    expect(provenanceOf({ inStore: false, fromAnchor: false, subBundle: false, localLink: false })).toBe('external')
  })
})

describe('orderProvenances', () => {
  it('dedupes and orders by management precedence', () => {
    expect(orderProvenances(['external', 'official', 'store', 'official']))
      .toEqual(['store', 'official', 'external'])
    expect(orderProvenances(['local-link', 'sub-bundle'])).toEqual(['sub-bundle', 'local-link'])
  })
  it('is empty for an empty input', () => {
    expect(orderProvenances([])).toEqual([])
  })
})

describe('repoFromSpec', () => {
  it('extracts owner/repo from a github spec', () => {
    expect(repoFromSpec('github:owner/repo')).toBe('owner/repo')
    expect(repoFromSpec('github:owner/repo#path:/packages/thing')).toBe('owner/repo')
  })
  it('is undefined for a non-github or malformed spec', () => {
    expect(repoFromSpec('@scope/pkg@1.0.0')).toBeUndefined()
    expect(repoFromSpec('file:/x')).toBeUndefined()
    expect(repoFromSpec(undefined)).toBeUndefined()
    expect(repoFromSpec('github:owner')).toBeUndefined()
  })
})

describe('isUpdateAvailable', () => {
  it('is true when the latest beats every candidate', () => {
    expect(isUpdateAvailable('2.0.0', ['1.0.0', '1.5.0'])).toBe(true)
  })
  it('is false when a candidate already matches or exceeds latest', () => {
    expect(isUpdateAvailable('2.0.0', ['2.0.0'])).toBe(false)
    expect(isUpdateAvailable('2.0.0', ['3.0.0'])).toBe(false)
  })
  it('is false for an absent latest', () => {
    expect(isUpdateAvailable(undefined, ['1.0.0'])).toBe(false)
  })
  it('ignores empty candidates but is conservative on unparseable ones', () => {
    expect(isUpdateAvailable('2.0.0', ['', '1.0.0'])).toBe(true)
    // An unparseable candidate compares equal (0) → not newer → no false update.
    expect(isUpdateAvailable('2.0.0', ['not-a-version'])).toBe(false)
  })
})

describe('toUpdateInfo', () => {
  it('marks an npm plugin with a newer latest as updatable', () => {
    const info = toUpdateInfo(
      { name: 'p', versions: ['1.0.0'], usage: [{ dsh: 'd', profile: 'a', version: '1.0.0' }], origin: 'npm' },
      '2.0.0',
    )
    expect(info).toMatchObject({ name: 'p', origin: 'npm', applied: ['1.0.0'], archived: ['1.0.0'], latest: '2.0.0', updateAvailable: true, manual: false })
  })

  it('marks github/local origins as manual with no latest', () => {
    const info = toUpdateInfo(
      { name: 'g', versions: ['1.0.0'], usage: [{ dsh: 'd', profile: 'a', version: '1.0.0' }], origin: 'github' },
      undefined,
    )
    expect(info.manual).toBe(true)
    expect(info.latest).toBeUndefined()
    expect(info.updateAvailable).toBe(false)
  })

  it('treats a github origin with a resolved latest as checkable, not manual', () => {
    const info = toUpdateInfo(
      { name: 'g', versions: ['1.0.0'], usage: [{ dsh: 'd', profile: 'a', version: '1.0.0' }], origin: 'github' },
      '2.0.0',
    )
    expect(info.manual).toBe(false)
    expect(info.latest).toBe('2.0.0')
    expect(info.updateAvailable).toBe(true)
  })

  it('dedupes applied versions across profiles', () => {
    const info = toUpdateInfo(
      { name: 'p', versions: [], usage: [{ dsh: 'd', profile: 'a', version: '1.0.0' }, { dsh: 'd', profile: 'b', version: '1.0.0' }], origin: 'npm' },
      '1.0.0',
    )
    expect(info.applied).toEqual(['1.0.0'])
  })
})

describe('annotationsFor', () => {
  const catalog = {
    updated: '2026-01-01',
    count: 2,
    categories: { ui: { en: 'UI', zh: '界面' } },
    plugins: [
      { name: 'dsh-ui', owner: 'o', url: 'https://github.com/o/dsh-ui', category: 'ui', description: {}, npm: '@o/dsh-ui', install: '' },
      { name: 'repo-only', owner: 'o', url: 'https://github.com/o/repo-only', category: 'ui', description: {}, deprecated: true, replacement: 'dsh-ui', install: '' },
    ],
  } as unknown as MarketCatalog

  it('keys npm-backed entries by npm name and github-only by catalog name', () => {
    const a = annotationsFor(catalog)
    expect(a.plugins['@o/dsh-ui']).toEqual({ category: 'ui', name: 'dsh-ui' })
    expect(a.plugins['repo-only']).toMatchObject({ category: 'ui', deprecated: true, replacement: 'dsh-ui' })
  })

  it('passes the category label map through', () => {
    expect(annotationsFor(catalog).categories.ui).toEqual({ en: 'UI', zh: '界面' })
  })
})
