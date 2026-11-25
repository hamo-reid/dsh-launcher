/**
 * What the home-usage block publishes, and what it refuses to imply.
 *
 * The panel's own initial state is one button (measuring walks every
 * `node_modules`, so it never runs on mount); the numbers are only on screen once
 * a scan has happened. So the interesting assertions live on `HomeBlock`, which
 * takes the measurement as a prop — server-rendered, like the other panel render
 * tests in this directory.
 *
 * What is pinned here is the honesty of the three numbers: the headline is the
 * RECLAIMABLE figure, the apparent sum is labelled as such, shared bytes are
 * called out, and a profile's node_modules says out loud that its real cost is
 * the plugin store's.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '../../i18n/locales/en'
import HomeUsagePanel, { HomeBlock, ownerNames } from './HomeUsagePanel.tsx'
import type { DshEntry, DshHomeUsage } from '../../../../shared/types.ts'

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    resources: { en },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
})

/** A measured home: 2 KB apparent, 1 KB of it reclaimable, the rest shared. */
const home = (over: Partial<DshHomeUsage> = {}): DshHomeUsage => ({
  home: 'C:/dsh/homes/official',
  dshIds: ['a'],
  exists: true,
  apparentBytes: 2048,
  reclaimableBytes: 1024,
  sharedBytes: 1024,
  files: 3,
  errors: 0,
  truncated: false,
  scannedAt: '2026-01-01T10:00:00.000Z',
  durationMs: 12,
  entries: [
    { name: 'sessions', kind: 'dir', role: 'sessions', apparentBytes: 1024, reclaimableBytes: 1024, sharedBytes: 0, files: 2 },
    { name: 'profiles', kind: 'dir', role: 'profiles', apparentBytes: 1024, reclaimableBytes: 0, sharedBytes: 1024, files: 1, nodeModulesBytes: 900 },
  ],
  ...over,
})

const block = (row: DshHomeUsage, opts: { owners?: string; view?: 'bars' | 'pie' } = {}): string =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18next}>
      <HomeBlock row={row} owners={opts.owners ?? 'official'} view={opts.view ?? 'bars'} />
    </I18nextProvider>,
  )

describe('the home usage panel', () => {
  const dsh = (id: string, name: string): DshEntry => ({ id, name, execPath: id, version: '1', home: '/h' })

  const panel = (selectedId?: string): string => renderToStaticMarkup(
    <I18nextProvider i18n={i18next}>
      <HomeUsagePanel dshes={[dsh('a', 'official')]} selectedId={selectedId} />
    </I18nextProvider>,
  )

  it('is a title and one button, and says nothing else', () => {
    const html = panel('a')
    expect(html).toContain('Home disk usage')
    expect(html).toContain('Calculate sizes')
    // One line naming the action, no paragraph about costs — the body is never
    // simply blank.
    expect(html).toContain('Click “Calculate sizes” to measure')
    // The view switch only appears once there is something to switch.
    expect(html).not.toContain('List')
    expect(html).not.toContain('Pie')
  })

  it('is dead when no dsh is selected', () => {
    // Nothing to measure, and silently measuring someone else's home is worse.
    expect(panel(undefined)).toContain('disabled')
  })
})

describe('a measured home', () => {
  it('leads with what deleting it frees, and labels the apparent sum as such', () => {
    const html = block(home())
    expect(html).toContain('Reclaimable ≈ 1.0 KB')
    // The raw sum is present but never presented as the disk cost.
    expect(html).toContain('Apparent 2.0 KB')
    expect(html).toContain('3 files')
  })

  it('calls out bytes that another install also holds', () => {
    const html = block(home())
    expect(html).toContain('1.0 KB shared by hard link')
  })

  it('says where a profile node_modules really lives', () => {
    const html = block(home())
    expect(html).toContain('profiles: 900 B from the store')
  })

  it('names every dsh that shares the home', () => {
    const html = block(home(), { owners: 'official, beta' })
    expect(html).toContain('official, beta')
    // The panel measures one dsh, so a "current" badge would only restate that.
    expect(html).not.toContain('Current')
  })

  it('draws the same numbers as a donut when asked', () => {
    const bars = block(home())
    const pie = block(home(), { view: 'pie' })
    // The donut replaces the bar list and opens on the total; the bar view has no
    // such readout.
    expect(pie).toContain('Total')
    expect(bars).not.toContain('Total')
    expect(pie).toContain('sessions')
  })

  it('offers the structure browser and nothing else', () => {
    const html = block(home())
    // Reading a size and then wanting to know WHERE it went is the same gesture.
    expect(html).toContain('Browse files')
    // Opening the folder now lives in 目录配置, next to the path it opens — a
    // second copy here would be the same action twice on one screen.
    expect(html).not.toContain('Open folder')
  })

  it('reports a home that does not exist instead of showing a zero', () => {
    const html = block(home({ exists: false }))
    expect(html).toContain('home directory missing')
    expect(html).not.toContain('Reclaimable ≈')
  })

  it('states an unreadable subtree and a truncated scan as caveats', () => {
    const html = block(home({ errors: 4, truncated: true }))
    expect(html).toContain('4 entries could not be read')
    expect(html).toContain('The scan hit its budget')
  })

  it('lists an entry it has no role for rather than dropping its size', () => {
    const html = block(home({
      entries: [{ name: 'something-new', kind: 'dir', role: 'unknown', apparentBytes: 2048, reclaimableBytes: 2048, sharedBytes: 0, files: 1 }],
    }))
    expect(html).toContain('something-new')
    expect(html).toContain('2.0 KB')
  })
})

describe('owner naming', () => {
  const dsh = (id: string, name: string): DshEntry =>
    ({ id, name, execPath: id, version: '1', home: '/h' })

  it('names every dsh that shares a home', () => {
    expect(ownerNames(['a', 'b'], [dsh('a', 'official'), dsh('b', 'beta')])).toBe('official, beta')
  })

  it('drops an id the registry no longer knows instead of printing the path', () => {
    // A row measured before the dsh was removed still carries its id, and that id
    // IS an executable path — printing it as a heading would be noise, not a name.
    const gone = 'C:\\tools\\dsh\\dsh.cmd'
    expect(ownerNames(['a', gone], [dsh('a', 'official')])).toBe('official')
    expect(ownerNames([gone], [dsh('a', 'official')])).toBe('')
  })
})
