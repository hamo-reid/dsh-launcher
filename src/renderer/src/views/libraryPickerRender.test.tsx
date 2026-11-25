/**
 * What a "pick from the library" body shows: a search field, ONE page of rows,
 * and a pager that states the real total.
 *
 * `LibraryPicker` is the shared body of the skills and MCP dialogs and is
 * deliberately stateless, so it can be server-rendered here — a `Modal` renders
 * through a portal, which a server render cannot produce (the same reason
 * `InstallSkillFields` is separated from its dialog).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '../i18n/locales/en'
import { LibraryPicker } from './LibraryModals.tsx'

const rows = Array.from({ length: 20 }, (_, index) => `entry-${String(index).padStart(2, '0')}`)

const render = (over: {
  /** Rows left after the dialog's own toggle. */
  rows?: readonly string[]
  /** Library size before that toggle (0 = the library itself is empty). */
  total?: number
  query?: string
  page?: number
  toolbar?: boolean
} = {}): string => {
  const visible = over.rows ?? rows
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18next}>
      <LibraryPicker
        rows={visible}
        total={over.total ?? visible.length}
        query={over.query ?? ''}
        onQuery={() => undefined}
        page={over.page ?? 1}
        onPage={() => undefined}
        fields={row => [row]}
        keyOf={row => row}
        renderRow={row => <span>{row}</span>}
        empty={<span>library is empty</span>}
        searchPlaceholder="Search names"
        toolbar={over.toolbar === true ? <span>hide up-to-date</span> : undefined}
      />
    </I18nextProvider>,
  )
}

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    resources: { en },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
})

describe('a library picker', () => {
  it('offers the search field and only the first page of rows', () => {
    const html = render()
    expect(html).toContain('Search names')
    expect(html).toContain('entry-00')
    expect(html).toContain('entry-07')
    // Row 9 of 20 belongs to page 2 — painting it here is what made the old
    // dialog unusable with a real library.
    expect(html).not.toContain('entry-08')
  })

  it('states the real total next to the pager', () => {
    expect(render()).toContain('20 entries')
  })

  it('shows the requested page, not always the first', () => {
    const html = render({ page: 2 })
    expect(html).toContain('entry-08')
    expect(html).not.toContain('entry-00')
  })

  it('pages the matches of a search, and reports those instead of the library', () => {
    const html = render({ query: 'entry-1' })
    // 10 rows match; the header must say 10, not 20.
    expect(html).toContain('10 entries')
    expect(html).toContain('entry-10')
    expect(html).not.toContain('entry-09')
  })

  it('distinguishes "nothing matched" from "the library is empty"', () => {
    const noMatch = render({ query: 'zzz' })
    expect(noMatch).toContain('No entry matches')
    expect(noMatch).toContain('zzz')
    // The empty-library message would be a different (and false) claim.
    expect(noMatch).not.toContain('library is empty')
  })

  it('shows no search box when there is nothing to search', () => {
    const html = render({ rows: [], total: 0 })
    expect(html).toContain('library is empty')
    expect(html).not.toContain('Search names')
    expect(html).not.toContain('entries')
  })

  it('keeps the way out on screen when the dialog filter hid every row', () => {
    // The library has entries, the toggle removed all of them: this is NOT an
    // empty library, and the toggle has to stay reachable or there is no exit.
    const html = render({ rows: [], total: 20, toolbar: true })
    expect(html).toContain('Nothing left to pick')
    expect(html).toContain('Search names')
    expect(html).toContain('hide up-to-date')
    expect(html).not.toContain('library is empty')
  })

  it('renders the extra filter control beside the search box', () => {
    expect(render({ toolbar: true })).toContain('hide up-to-date')
    expect(render()).not.toContain('hide up-to-date')
  })

  it('hides the pager when everything fits on one page', () => {
    const html = render({ rows: rows.slice(0, 5) })
    expect(html).toContain('entry-04')
    expect(html).not.toContain('ant-pagination')
  })
})
