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
import AboutView from './AboutView.tsx'

const REPO = 'https://github.com/hamo-reid/dsh-launcher'

const markup = (): string =>
  renderToStaticMarkup(<I18nextProvider i18n={i18next}><AboutView /></I18nextProvider>)

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
