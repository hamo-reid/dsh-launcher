/**
 * The same numbers as the bar list, drawn as a donut â€?the other way of answering
 * "what is big here" at a glance.
 *
 * chart.js (canvas) rather than a d3-based React chart library: recharts alone
 * pulled redux, immer and the whole `victory-vendor` d3 set into the DSH chunk
 * (70 kB â†?824 kB), which is the opposite of what a tab opened for one number
 * should cost. chart.js has exactly one transitive dependency, ships its own
 * entrance animation, and the interaction the design wants â€?a hovered slice
 * that lifts out, a centre readout that follows the pointer â€?is a handful of
 * options.
 *
 * The centre readout and the legend are OUR DOM, not canvas text: they stay crisp
 * at any DPR, they follow the light/dark tokens, and they are the part a server
 * render can assert.
 *
 * Slices are the largest entries plus one aggregated remainder, so the donut
 * always adds up to the same total the bar list shows. Colors come from antd's
 * preset colour tokens (`token.blue`, `token.cyan`, â€? so they follow the theme
 * switch â€?`docs/ui-guidelines.md` Â§1 forbids raw hex here too.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { ArcElement, Chart, DoughnutController } from 'chart.js'
import { Doughnut } from 'react-chartjs-2'
import { fmtBytes } from '../../lib/format.ts'
import type { ChartOptions } from 'chart.js'
import type { HomeEntryUsage } from '../../../../shared/types.ts'

// Only what a doughnut needs: the default `chart.js` entry would register every
// controller and element the library has.
Chart.register(ArcElement, DoughnutController)

/** One drawn slice. */
export interface PieSlice {
  label: string
  bytes: number
  color: string
}

/** How many named slices before the rest is folded into one. */
const MAX_SLICES = 7

/**
 * Geometry of the donut box, in px.
 *
 * `padding` is not cosmetic: a hovered arc LIFTS OUT of the ring by `hoverOffset`
 * px, and anything drawn past the canvas edge is clipped. Without the inset the
 * ring sat flush against the edge and the hover read as a sliced-off wedge. The
 * invariant `size/2 - padding - hoverOffset > 0` is pinned by a test.
 */
export const CHART_BOX = { size: 180, padding: 12, hoverOffset: 6 } as const

/** Fixed so the diagram does not reflow while a scan settles. */
const SIZE = CHART_BOX.size

/**
 * The slices for a level: the largest entries by size, then one `other` bucket.
 *
 * `entries` is expected largest-first (the scan returns it that way), and the
 * remainder keeps the total honest: the donut always adds up to the number the
 * bar list shows.
 * @param entries - the entries to draw, largest first.
 * @param max - how many named slices to keep.
 * @param colors - a palette, cycled (one hue per slice).
 * @param otherLabel - the label for the aggregated tail.
 */
export function pieSlices(
  entries: readonly HomeEntryUsage[],
  max: number,
  colors: readonly string[],
  otherLabel: string,
): PieSlice[] {
  if (entries.length === 0 || colors.length === 0) return []
  const kept = entries.slice(0, Math.max(1, max))
  const rest = entries.slice(kept.length)
  const slices: PieSlice[] = kept.map((entry, index) => ({
    label: entry.name,
    bytes: entry.apparentBytes,
    color: colors[index % colors.length],
  }))
  const restBytes = rest.reduce((sum, entry) => sum + entry.apparentBytes, 0)
  if (restBytes > 0) {
    slices.push({ label: otherLabel, bytes: restBytes, color: colors[slices.length % colors.length] })
  }
  return slices.filter(slice => slice.bytes > 0)
}

/** A share as the legend prints it: whole percent, and `<1%` rather than a lie. */
export function formatShare(bytes: number, total: number): string {
  if (total <= 0) return ''
  const percent = (bytes / total) * 100
  return percent < 1 ? '<1%' : `${String(Math.round(percent))}%`
}

/** Whether the OS asks for reduced motion â€?the donut must not animate then. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export default function HomeUsagePie({ entries }: { entries: readonly HomeEntryUsage[] }): JSX.Element {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const reducedMotion = usePrefersReducedMotion()
  // The slice under the pointer (canvas OR legend). `null` means "show the total".
  const [active, setActive] = useState<number | null>(null)
  const chart = useRef<Chart<'doughnut'> | null>(null)
  // What the canvas is currently highlighting, so a hover that names the same
  // slice twice does not re-run a chart update on every mousemove.
  const applied = useRef<number | null>(null)

  const palette = [
    token.blue, token.cyan, token.purple, token.green,
    token.gold, token.orange, token.magenta, token.geekblue,
  ]
  const slices = pieSlices(entries, MAX_SLICES, palette, t('dsh.usage.other'))
  const total = slices.reduce((sum, slice) => sum + slice.bytes, 0)

  // The chart's props must be STABLE across a hover re-render: react-chartjs-2
  // calls `chart.update()` whenever `data`/`options` change identity, and an
  // update replays the entrance animation. Memoised on the slice VALUES, so a
  // hover (which only changes `active`) cannot retrigger it.
  const signature = slices.map(slice => `${slice.label}:${String(slice.bytes)}`).join('|')
  const chartData = useMemo(() => ({
    labels: slices.map(slice => slice.label),
    datasets: [{
      data: slices.map(slice => slice.bytes),
      backgroundColor: slices.map(slice => slice.color),
      borderWidth: 0,
      spacing: 2,
      borderRadius: 4,
      // The hovered arc lifts out of the ring â€?the whole interaction, no tooltip.
      hoverOffset: CHART_BOX.hoverOffset,
    }],
    // `slices` is fully described by `signature` (label + bytes); the colors only
    // change with the theme, which rebuilds this component anyway. Depending on
    // the array itself would defeat the memo â€?it is a new array every render.
  }), [signature])
  const chartOptions = useMemo<ChartOptions<'doughnut'>>(() => ({
    responsive: false,
    maintainAspectRatio: false,
    // Room for the hovered arc to lift out without hitting the canvas edge.
    layout: { padding: CHART_BOX.padding },
    cutout: '68%',
    // Start at 12 o'clock; chart.js counts from 3 o'clock by default.
    rotation: -90,
    animation: reducedMotion ? false : { duration: 650, easing: 'easeOutQuart' },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    onHover: (_event, elements) => setActive(elements.length > 0 ? elements[0].index : null),
  }), [reducedMotion])

  // Two-way hover: the legend sets `active`, the canvas reads it back. Chart.js
  // only pops the hovered arc when it knows which one is active, so the legend
  // has to drive it imperatively.
  useEffect(() => {
    const instance = chart.current
    if (instance === null || applied.current === active) return
    applied.current = active
    instance.setActiveElements(active === null ? [] : [{ datasetIndex: 0, index: active }])
    instance.update('none')
  }, [active])

  if (total === 0) return <></>
  const focused = active !== null ? slices[active] : undefined

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: token.paddingLG,
      flexWrap: 'wrap',
      paddingBlock: token.paddingSM,
    }}>
      {/* A canvas is invisible to a screen reader, so the box carries the label
          and the legend below carries the numbers. */}
      <div
        role="img"
        aria-label={t('dsh.usage.pieLabel')}
        style={{ position: 'relative', width: SIZE, height: SIZE, flex: '0 0 auto' }}
      >
        <Doughnut ref={chart} data={chartData} options={chartOptions} width={SIZE} height={SIZE} />
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          pointerEvents: 'none',
          textAlign: 'center',
        }}>
          <span style={{
            // Stay inside the hole: the inner diameter is cutout Ã— the drawn
            // radius, and the label must not spill under the ring.
            maxWidth: SIZE * 0.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: token.fontSizeSM,
            color: token.colorTextTertiary,
          }}>
            {focused?.label ?? t('dsh.usage.total')}
          </span>
          <span style={{ fontWeight: 600, fontSize: token.fontSizeLG, fontVariantNumeric: 'tabular-nums' }}>
            {fmtBytes(focused?.bytes ?? total)}
          </span>
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 200 }} role="list">
        {slices.map((slice, index) => {
          const lit = active === null || active === index
          return (
            <div
              key={slice.label}
              role="listitem"
              tabIndex={0}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 8px',
                borderRadius: token.borderRadius,
                background: active === index ? token.colorFillQuaternary : undefined,
                transition: reducedMotion ? undefined : 'background 160ms ease',
              }}
            >
              <span style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: slice.color,
                flex: '0 0 auto',
                opacity: lit ? 1 : 0.35,
                transition: reducedMotion ? undefined : 'opacity 160ms ease',
              }} />
              <span style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: token.fontSizeSM,
                opacity: lit ? 1 : 0.55,
                transition: reducedMotion ? undefined : 'opacity 160ms ease',
              }}>
                {slice.label}
              </span>
              <span style={{
                fontSize: token.fontSizeSM,
                color: token.colorTextSecondary,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {fmtBytes(slice.bytes)}
              </span>
              <span style={{
                width: 42,
                textAlign: 'right',
                fontSize: token.fontSizeSM,
                color: token.colorTextTertiary,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {formatShare(slice.bytes, total)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
