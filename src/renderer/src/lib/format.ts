/**
 * Display formatting shared across the renderer: byte sizes, dates, counts.
 *
 * All pure, and all locale-driven through the platform (`toLocaleDateString` /
 * `Intl.NumberFormat`) exactly as the per-view copies were — the app's UI language
 * never changed how numerals rendered, so this does not either.
 */

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const

/** A byte count as `1.5 KB` / `150 KB` / `2.0 GB`. One decimal below 100 units and
 * none above, so a column of sizes stays scannable at both ends. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  let value = n
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < BYTE_UNITS.length - 1)
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${BYTE_UNITS[unit]}`
}

/** A date alone (`2026/9/21`), or `''` for an unparseable value. */
export function fmtDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()
}

/** A date and time together, or `''` for an unparseable value. */
export function fmtDateTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

/** One formatter instance, so a render does not build an `Intl.NumberFormat` per
 * call. Thousands-separated, for counts like downloads and star counts. */
const numberFormat = new Intl.NumberFormat()

/** A thousands-separated number. */
export function fmtNum(n: number): string {
  return numberFormat.format(n)
}

/** A duration for a task row: `850 ms`, `3.2 s`, `1 分 05 秒`. Sub-second stays in
 * milliseconds because that is the range where the exact number matters (a
 * cached install finished in 300 ms, a hung one took 40 s — the magnitude IS the
 * diagnosis). */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${String(Math.round(ms))} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes)} 分 ${String(seconds).padStart(2, '0')} 秒`
}
