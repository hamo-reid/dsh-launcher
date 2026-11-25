/**
 * Search + paging for the "pick from the library" dialogs.
 *
 * Both pickers (skills, MCP) list a machine-wide library that grows without
 * bound: a working setup easily holds hundreds of entries, and a dialog that
 * paints every row is unusable long before it is slow. The arithmetic lives here
 * so the two dialogs page identically, and so the clamping rules can be tested
 * without a DOM — the same reason `versionSizes.ts` and `skillInstallState.ts`
 * exist next door.
 *
 * Nothing here invents data: a blank query returns every row, and a page number
 * out of range is clamped rather than answered with an empty list. A picker that
 * goes blank because a filter shrank the list is a bug the user reads as "the
 * library lost my entry".
 */

/** Rows per page. A picker row is one or two lines, so a page is a screenful. */
export const LIB_ROWS_PER_PAGE = 8

/** The searchable text of one row. `undefined` fields are ignored, so a row with
 * no description is not filtered out by the missing field itself. */
export type RowFields<T> = (row: T) => readonly (string | undefined)[]

/** Rows whose fields contain `query`, case-insensitively. A blank query matches
 * everything (subtracting a trim-only query, which also matches everything). */
export function filterByQuery<T>(rows: readonly T[], query: string, fields: RowFields<T>): T[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...rows]
  return rows.filter(row => fields(row).some(field =>
    typeof field === 'string' && field !== '' && field.toLowerCase().includes(needle)))
}

/** One page of rows. */
export interface PageSlice<T> {
  /** The rows on this page. */
  items: T[]
  /** The page actually shown — clamped into range. */
  page: number
  /** Total pages, at least 1: an empty list is still "1 of 1", not "0 of 0". */
  pages: number
  /** Rows matching the filter (not the page size). */
  total: number
  /** The page size used. */
  size: number
}

/**
 * Slice one page out of `rows`, clamping `page` into `1..pages`.
 *
 * Clamping (rather than returning an empty slice) is what makes a shrinking list
 * safe: typing another character narrows the matches, and a page that no longer
 * exists must land on the last real one instead of a blank dialog.
 * @param rows - the filtered rows.
 * @param page - the requested page (any number, including NaN / 0 / negative).
 * @param size - rows per page; floored and raised to at least 1.
 */
export function pageOf<T>(rows: readonly T[], page: number, size = LIB_ROWS_PER_PAGE): PageSlice<T> {
  const safeSize = Math.max(1, Math.floor(size) || 1)
  const pages = Math.max(1, Math.ceil(rows.length / safeSize))
  const requested = Math.floor(page) || 1
  const current = Math.min(Math.max(1, requested), pages)
  const start = (current - 1) * safeSize
  return {
    items: rows.slice(start, start + safeSize),
    page: current,
    pages,
    total: rows.length,
    size: safeSize,
  }
}
