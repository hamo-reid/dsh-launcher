/**
 * Aggregation of unresolvable profile references. Pure functions over the
 * overview, so the banner's wording and ordering are testable without a DOM.
 */
import { describe, expect, it } from 'vitest'
import { brokenPluginNames, brokenRefs, describeBroken, isBrokenUsage } from './pluginRefs.ts'
import type { InstalledOverviewRow, PluginUsagePoint } from '../../../shared/types.ts'

const usage = (over: Partial<PluginUsagePoint> = {}): PluginUsagePoint =>
  ({ dsh: 'dsh', profile: 'p1', ...over })

const row = (name: string, usagePoints: PluginUsagePoint[]): InstalledOverviewRow =>
  ({ name, usage: usagePoints }) as InstalledOverviewRow

describe('brokenRefs', () => {
  it('collects only the broken ones, sorted by plugin then profile', () => {
    const rows = [
      row('zeta', [usage({ profile: 'p2', broken: true })]),
      row('alpha', [
        usage({ profile: 'p9' }),
        usage({ profile: 'p1', broken: true, spec: 'file:/gone' }),
        usage({ profile: 'p0', broken: true }),
      ]),
    ]
    expect(brokenRefs(rows)).toEqual([
      { name: 'alpha', dsh: 'dsh', profile: 'p0' },
      { name: 'alpha', dsh: 'dsh', profile: 'p1', spec: 'file:/gone' },
      { name: 'zeta', dsh: 'dsh', profile: 'p2' },
    ])
  })

  it('is empty when every reference resolves', () => {
    expect(brokenRefs([row('a', [usage()]), row('b', [usage({ broken: false })])])).toEqual([])
  })
})

describe('describeBroken', () => {
  it('groups by plugin so the banner reads one line per plugin', () => {
    const refs = brokenRefs([
      row('a', [usage({ profile: 'p1', broken: true }), usage({ profile: 'p2', broken: true })]),
      row('b', [usage({ profile: 'q1', broken: true })]),
    ])
    expect(describeBroken(refs)).toEqual([
      { name: 'a', profiles: 'p1 · p2' },
      { name: 'b', profiles: 'q1' },
    ])
    expect(brokenPluginNames(refs)).toEqual(['a', 'b'])
  })
})

describe('isBrokenUsage', () => {
  it('is exactly the flag the backend set, so the label cannot drift from the state', () => {
    expect(isBrokenUsage({ broken: true })).toBe(true)
    expect(isBrokenUsage({})).toBe(false)
    expect(isBrokenUsage({ broken: false })).toBe(false)
  })
})
