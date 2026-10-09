/**
 * What the dsh skills panel shows before anything is selected: its profile scope.
 *
 * A preset contributes skill roots only inside a profile's composition, so "no
 * profile" is a state the page has to STATE — the defect it fixes was a panel that
 * silently listed fewer roots because the page never passed a profile at all.
 *
 * Server-rendered on purpose: effects do not run, which is exactly the initial
 * state under test (nothing selected yet). `window.api` is therefore never
 * touched — no IPC mock is needed for this assertion.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '../i18n/locales/en'
import SkillsManagePanel from './SkillsManagePanel.tsx'

const render = (): string => renderToStaticMarkup(
  <I18nextProvider i18n={i18next}>
    <SkillsManagePanel dshId="a" />
  </I18nextProvider>,
)

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    resources: { en },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
})

describe('the dsh skills panel', () => {
  it('offers the profile scope, and explains what an unselected one is missing', () => {
    const html = render()
    // The scope control exists at all — the old panel had no dimension for it.
    expect(html).toContain('Profile (the scope that composes skill roots)')
    // ...and the machine-level view says what it is rather than showing fewer rows.
    expect(html).toContain('No profile selected')
    expect(html).toContain('skill roots contributed by presets only exist inside a profile')
  })

  it('carries the authoring actions and the drop target', () => {
    const html = render()
    expect(html).toContain('New skill')
    expect(html).toContain('Import ZIP')
    expect(html).toContain('Install from library')
    expect(html).toContain('Drop a zip here to import')
    expect(html).toContain('You can also drop it anywhere on this panel')
  })
})
