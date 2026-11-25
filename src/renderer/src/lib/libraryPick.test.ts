/**
 * Search and paging arithmetic for the library pickers.
 *
 * Pure, and pinned on the two behaviours a person actually notices: a blank
 * query must not empty the list, and a page that no longer exists must land on
 * the last real one instead of a blank dialog.
 */
import { describe, expect, it } from 'vitest'
import { LIB_ROWS_PER_PAGE, filterByQuery, pageOf } from './libraryPick.ts'

interface Row { name: string; description?: string }

const rows: Row[] = [
  { name: 'alpha', description: 'First skill' },
  { name: 'beta', description: 'Second one' },
  { name: 'Gamma', description: undefined },
]

describe('filterByQuery', () => {
  it('matches everything for a blank or whitespace-only query', () => {
    expect(filterByQuery(rows, '', row => [row.name])).toHaveLength(3)
    expect(filterByQuery(rows, '   ', row => [row.name])).toHaveLength(3)
  })

  it('matches case-insensitively, on any field', () => {
    expect(filterByQuery(rows, 'GAM', row => [row.name]).map(row => row.name)).toEqual(['Gamma'])
    expect(filterByQuery(rows, 'second', row => [row.name, row.description]).map(row => row.name))
      .toEqual(['beta'])
  })

  it('ignores an absent field instead of dropping the row that owns it', () => {
    expect(filterByQuery(rows, 'gamma', row => [row.name, row.description]).map(row => row.name))
      .toEqual(['Gamma'])
  })

  it('answers an unmatched query with an empty list, not with everything', () => {
    expect(filterByQuery(rows, 'zzz', row => [row.name, row.description])).toEqual([])
  })

  it('leaves the input untouched', () => {
    const before = [...rows]
    filterByQuery(rows, '', row => [row.name])
    expect(rows).toEqual(before)
  })
})

describe('pageOf', () => {
  const list = Array.from({ length: 20 }, (_, index) => index)

  it('slices one page and reports the totals', () => {
    const first = pageOf(list, 1, 8)
    expect(first.items).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(first.pages).toBe(3)
    expect(first.total).toBe(20)
    // The last page is short, and that is a page — not a reason to hide it.
    expect(pageOf(list, 3, 8).items).toEqual([16, 17, 18, 19])
  })

  it('clamps a page outside the range instead of showing nothing', () => {
    expect(pageOf(list, 99, 8).page).toBe(3)
    expect(pageOf(list, 99, 8).items).toHaveLength(4)
    for (const bad of [0, -5, Number.NaN]) expect(pageOf(list, bad, 8).page).toBe(1)
  })

  it('treats an empty list as one empty page', () => {
    const empty = pageOf([], 4, 8)
    expect(empty.items).toEqual([])
    expect(empty.pages).toBe(1)
    expect(empty.page).toBe(1)
    expect(empty.total).toBe(0)
  })

  it('raises a nonsensical page size to one row rather than zero', () => {
    expect(pageOf(list, 1, 0).size).toBe(1)
    expect(pageOf(list, 1, 0).pages).toBe(20)
  })

  it('defaults to the picker page size', () => {
    expect(pageOf(list, 1).size).toBe(LIB_ROWS_PER_PAGE)
  })
})
