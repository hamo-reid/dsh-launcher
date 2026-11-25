/**
 * What one level of the structure browser says.
 *
 * The modal itself only wraps `BrowseLevel` in a dialog and fetches the level, so
 * the presentational half is rendered directly (a portal cannot be server-rendered
 * — the same reason the other panel render tests assert on exported blocks).
 *
 * What is pinned: names are unambiguous about being folders, the totals describe
 * the LEVEL rather than the rows shown, an omitted remainder is stated, and a
 * `node_modules` row is tagged as the plugin store's bytes.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '../../i18n/locales/en'
import { BrowseLevel, crumbsOf, joinRel } from './HomeBrowseModal.tsx'
import type { HomeBrowseResult } from '../../../../shared/types.ts'

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    resources: { en },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
})

const level = (over: Partial<HomeBrowseResult> = {}): HomeBrowseResult => ({
  home: 'C:/dsh/homes/official',
  relPath: 'profiles',
  path: 'C:/dsh/homes/official/profiles',
  exists: true,
  apparentBytes: 2048,
  reclaimableBytes: 1024,
  sharedBytes: 1024,
  files: 9,
  errors: 0,
  omitted: 0,
  truncated: false,
  scannedAt: '2026-01-01T10:00:00.000Z',
  durationMs: 3,
  entries: [
    { name: 'base-web', kind: 'dir', role: 'unknown', apparentBytes: 2048, reclaimableBytes: 0, sharedBytes: 2048, files: 8 },
  ],
  ...over,
})

const render = (data: HomeBrowseResult): string => renderToStaticMarkup(
  <I18nextProvider i18n={i18next}>
    <BrowseLevel data={data} onNavigate={() => undefined} />
  </I18nextProvider>,
)

describe('browse path helpers', () => {
  it('joins a child onto the current level with a forward slash', () => {
    expect(joinRel('', 'profiles')).toBe('profiles')
    expect(joinRel('profiles', 'base-web')).toBe('profiles/base-web')
  })

  it('builds one crumb per segment, each carrying the path that reaches it', () => {
    expect(crumbsOf('')).toEqual([])
    expect(crumbsOf('profiles')).toEqual([{ label: 'profiles', rel: 'profiles' }])
    expect(crumbsOf('profiles/base-web/node_modules')).toEqual([
      { label: 'profiles', rel: 'profiles' },
      { label: 'base-web', rel: 'profiles/base-web' },
      { label: 'node_modules', rel: 'profiles/base-web/node_modules' },
    ])
  })
})

describe('a browsed level', () => {
  it('marks a folder as a folder and totals the level', () => {
    const html = render(level())
    expect(html).toContain('base-web/')
    expect(html).toContain('This level: 2.0 KB · 9 files')
    // The breadcrumb names where we are, and the root is still reachable.
    expect(html).toContain('profiles')
    expect(html).toContain('C:/dsh/homes/official/profiles')
  })

  it('says how many entries the row cap left out', () => {
    const html = render(level({ omitted: 3 }))
    expect(html).toContain('3 more entries are not shown')
  })

  it('tags a node_modules row as bytes that came from the store', () => {
    const html = render(level({
      entries: [{ name: 'node_modules', kind: 'dir', role: 'deps', apparentBytes: 900, reclaimableBytes: 0, sharedBytes: 900, files: 40, nodeModulesBytes: 900 }],
    }))
    expect(html).toContain('store hard link')
    // The generic "partly elsewhere" tag would say the same thing less precisely.
    expect(html).not.toContain('partly elsewhere')
  })

  it('tags a row whose bytes are shared outside the home', () => {
    const html = render(level())
    expect(html).toContain('partly elsewhere')
    expect(html).not.toContain('store hard link')
  })

  it('states an empty level and a missing one differently', () => {
    expect(render(level({ entries: [], apparentBytes: 0, files: 0 }))).toContain('Empty folder')
    expect(render(level({ exists: false, entries: [] }))).toContain('Folder missing')
  })

  it('carries the same caveats as the panel for a partial read', () => {
    const html = render(level({ errors: 2, truncated: true }))
    expect(html).toContain('2 entries could not be read')
    expect(html).toContain('The scan hit its budget')
  })

  it('makes a folder row a real control, not a click handler on a div', () => {
    const html = render(level())
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
  })

  it('does not claim "empty" for a level the budget stopped before scanning', () => {
    const html = render(level({ entries: [], truncated: true }))
    // "Empty folder" would contradict the warning that is also on screen.
    expect(html).not.toContain('Empty folder')
    expect(html).toContain('The scan hit its budget')
  })
})
