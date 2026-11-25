/**
 * The donut the usage panel can switch to, and the arithmetic behind it.
 *
 * The legend is our own DOM (recharts' own legend would need a browser to
 * measure), so the numbers a person reads — size and share per slice — are
 * assertable in a server render. The slice maths is pinned separately because a
 * wrong remainder would make the donut disagree with the bar list right above it.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '../../i18n/locales/en'
import HomeUsagePie, { CHART_BOX, formatShare, pieSlices } from './HomeUsagePie.tsx'
import type { HomeEntryUsage } from '../../../../shared/types.ts'

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    resources: { en },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
})

const entry = (name: string, apparentBytes: number): HomeEntryUsage =>
  ({ name, kind: 'dir', role: 'unknown', apparentBytes, reclaimableBytes: 0, sharedBytes: 0, files: 1 })

const COLORS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']

const render = (entries: HomeEntryUsage[]): string => renderToStaticMarkup(
  <I18nextProvider i18n={i18next}>
    <HomeUsagePie entries={entries} />
  </I18nextProvider>,
)

describe('pieSlices', () => {
  it('keeps the largest entries and folds the tail into one slice', () => {
    const slices = pieSlices([entry('a', 50), entry('b', 30), entry('c', 20), entry('d', 10)], 2, COLORS, 'Other')
    expect(slices.map(slice => slice.label)).toEqual(['a', 'b', 'Other'])
    // The remainder keeps the total honest: 20 + 10.
    expect(slices[2].bytes).toBe(30)
  })

  it('says nothing for an empty or zero-sized level', () => {
    expect(pieSlices([], 7, COLORS, 'Other')).toEqual([])
    expect(pieSlices([entry('a', 0)], 7, COLORS, 'Other')).toEqual([])
  })

  it('cycles the palette rather than running out of colours', () => {
    const slices = pieSlices([entry('a', 1), entry('b', 1), entry('c', 1)], 3, ['x', 'y'], 'Other')
    expect(slices.map(slice => slice.color)).toEqual(['x', 'y', 'x'])
  })

  it('never draws more named slices than asked for', () => {
    const many = Array.from({ length: 20 }, (_, index) => entry(`e${String(index)}`, index + 1))
    // Seven named + the remainder.
    expect(pieSlices(many, 7, COLORS, 'Other')).toHaveLength(8)
  })
})

describe('formatShare', () => {
  it('rounds to whole percent', () => {
    expect(formatShare(337, 477)).toBe('71%')
    expect(formatShare(477, 477)).toBe('100%')
  })

  it('says "<1%" instead of a misleading "0%"', () => {
    expect(formatShare(1, 100_000)).toBe('<1%')
  })

  it('says nothing when there is no total', () => {
    expect(formatShare(10, 0)).toBe('')
  })
})

describe('the donut box', () => {
  it('leaves room for the hovered arc, or the canvas clips it', () => {
    // The hovered arc lifts OUT of the ring by `hoverOffset`: the inset has to
    // cover that, and the ring must still have a positive radius afterwards.
    // (Before this was pinned, the ring sat flush against the edge and a hover
    // read as a sliced-off wedge.)
    expect(CHART_BOX.padding).toBeGreaterThanOrEqual(CHART_BOX.hoverOffset)
    expect(CHART_BOX.size / 2 - CHART_BOX.padding - CHART_BOX.hoverOffset).toBeGreaterThan(0)
  })
})

describe('the donut', () => {
  it('gives every slice a row with its size and share', () => {
    const html = render([entry('sessions', 1024 * 1024), entry('profiles', 1024 * 512), entry('tiny', 1)])
    expect(html).toContain('sessions')
    expect(html).toContain('profiles')
    expect(html).toContain('1.0 MB')
    expect(html).toContain('512 KB')
    // 1 MB of 1.5 MB, and the byte nobody would round to 0.
    expect(html).toContain('67%')
    expect(html).toContain('33%')
    expect(html).toContain('&lt;1%')
  })

  it('opens on the total, which is the number the panel leads with', () => {
    const html = render([entry('sessions', 1024)])
    expect(html).toContain('Total')
    expect(html).toContain('100%')
  })

  it('renders nothing at all for a home with no bytes', () => {
    expect(render([])).toBe('')
  })
})
