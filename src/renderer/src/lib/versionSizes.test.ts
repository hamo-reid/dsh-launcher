import { describe, expect, it } from 'vitest'
import { sumVersionSizes, versionSizeReading, versionsWithoutSize } from './versionSizes.ts'

describe('versionSizeReading', () => {
  it('reports a version\'s own size and what it shares with the rest', () => {
    // The version alone weighs 40 MB; the whole plugin (deduplicated) is 60 MB.
    // So 20 MB of that 60 is not in this version — it lives in another one.
    expect(versionSizeReading('1.0.0', { '1.0.0': 40 }, 60)).toEqual({ bytes: 40, shared: 20 })
  })

  it('says nothing when the version was not measured', () => {
    expect(versionSizeReading('2.0.0', { '1.0.0': 40 }, 60)).toEqual({})
    expect(versionSizeReading('2.0.0', undefined, 60)).toEqual({})
  })

  it('says nothing about sharing without a plugin total', () => {
    // Sizes were measured but the overview total was never calculated.
    expect(versionSizeReading('1.0.0', { '1.0.0': 40 }, undefined)).toEqual({ bytes: 40 })
  })

  it('never reports a negative share when a version exceeds the total', () => {
    // A version alone can out-weigh the deduplicated total: it holds a file the
    // total counts once and another version also references.
    expect(versionSizeReading('1.0.0', { '1.0.0': 80 }, 60)).toEqual({ bytes: 80 })
  })

  it('has no share to report when the version IS the whole plugin', () => {
    expect(versionSizeReading('1.0.0', { '1.0.0': 60 }, 60)).toEqual({ bytes: 60 })
  })

  it('treats a zero or absent total as nothing to derive', () => {
    expect(versionSizeReading('1.0.0', { '1.0.0': 10 }, 0)).toEqual({ bytes: 10 })
  })
})

describe('versionsWithoutSize', () => {
  it('lists only the versions with no measurement', () => {
    expect(versionsWithoutSize(['1.0.0', '2.0.0', '3.0.0'], { '1.0.0': 1, '3.0.0': 4 })).toEqual(['2.0.0'])
  })

  it('lists everything when nothing was measured', () => {
    expect(versionsWithoutSize(['1.0.0'], undefined)).toEqual(['1.0.0'])
  })

  it('is empty when all are measured', () => {
    expect(versionsWithoutSize(['1.0.0'], { '1.0.0': 1 })).toEqual([])
  })
})

describe('sumVersionSizes', () => {
  it('adds the measured values', () => {
    expect(sumVersionSizes(['1.0.0', '2.0.0'], { '1.0.0': 10, '2.0.0': 5 })).toBe(15)
  })

  it('skips unmeasured versions rather than counting them as zero-sized', () => {
    expect(sumVersionSizes(['1.0.0', '2.0.0'], { '1.0.0': 10 })).toBe(10)
  })

  it('is zero for nothing measured', () => {
    expect(sumVersionSizes(['1.0.0'], undefined)).toBe(0)
  })
})
