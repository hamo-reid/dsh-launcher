/**
 * The About page's contract with its copy: the three project links point at real
 * URLs, and every string on the page resolves.
 *
 * A missing i18n key renders as the key itself (`about.link.repo`), which looks
 * like a design choice in a screenshot and is invisible to typechecking — so the
 * markup is asserted for any leaked key. The page reads `window.api` only from
 * effects, which a server render does not run, so no stub is needed.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '../i18n/locales/en'
import AboutView, { UpdateReport } from './AboutView.tsx'
import type { AppRelease } from '../../../shared/types.ts'

const REPO = 'https://github.com/hamo-reid/dsh-launcher'

const markup = (): string =>
  renderToStaticMarkup(<I18nextProvider i18n={i18next}><AboutView /></I18nextProvider>)

const report = (node: JSX.Element): string =>
  renderToStaticMarkup(<I18nextProvider i18n={i18next}>{node}</I18nextProvider>)

const RELEASE: AppRelease = {
  tag: '0.6.0-beta1',
  version: '0.6.0-beta1',
  url: `${REPO}/releases/tag/v0.6.0-beta1`,
  publishedAt: '2026-10-01T09:00:00Z',
}

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    resources: { en },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
})

describe('About page', () => {
  it('links to the repository, its releases and its issues', () => {
    const html = markup()
    expect(html).toContain(`href="${REPO}"`)
    expect(html).toContain(`href="${REPO}/releases"`)
    expect(html).toContain(`href="${REPO}/issues"`)
    // Every outgoing link leaves the app; the main process sends them to the browser.
    expect(html.match(/target="_blank"/g)?.length).toBe(3)
    expect(html.match(/rel="noreferrer"/g)?.length).toBe(3)
  })

  it('resolves every string it renders', () => {
    // The one failure mode typechecking cannot see: a key that does not exist
    // renders as itself, and only a person looking at the page would notice.
    const html = markup()
    expect(html).not.toContain('about.')
    expect(html).not.toContain('common.')
  })

  it('tells the visitor which build is installed, even before the check returns', () => {
    const html = markup()
    // The version is fetched in an effect, so a server render shows the placeholder
    // — which must be a placeholder rather than an empty gap.
    expect(html).toContain('DSH Launcher')
    expect(html).toContain('Checking for updates…')
    expect(html).toContain('Check for updates')
  })

  it('carries the license line, because an About page is where it belongs', () => {
    expect(markup()).toContain('released under the MIT license')
  })
})

describe('the update report', () => {
  it('shows no row it cannot fill when the app is current', () => {
    // The defect this pins: a table with "Latest —" and "Published —" reads as a
    // failed load, and "latest: none" is the state where nothing is unknown —
    // the answer is simply that you already have it.
    const html = report(<UpdateReport update={{ status: 'ok', latest: null }} version="0.5.1-beta1" checkedAt="09:41" />)
    expect(html).toContain('You are up to date')
    expect(html).toContain('0.5.1-beta1')
    expect(html).toContain('checked at 09:41')
    expect(html).not.toContain('Latest')
    expect(html).not.toContain('Published')
  })

  it('shows the release rows only when a newer release exists', () => {
    const html = report(<UpdateReport update={{ status: 'ok', latest: RELEASE }} version="0.5.1-beta1" checkedAt="09:41" />)
    expect(html).toContain('Latest')
    expect(html).toContain('0.6.0-beta1')
    expect(html).toContain('Published')
    // The date is the release's, rendered as an unambiguous ISO day.
    expect(html).toContain('2026-10-01')
    expect(html).toContain(`href="${RELEASE.url}"`)
  })

  it('says the check failed instead of pretending the version is unknown', () => {
    const html = report(<UpdateReport update={{ status: 'error', message: 'HTTP 403' }} version="0.5.1-beta1" />)
    expect(html).toContain('Update check failed')
    expect(html).toContain('0.5.1-beta1')
    // The transport detail is a tooltip, so it is not in the server markup.
    expect(html).not.toContain('HTTP 403')
  })
})
