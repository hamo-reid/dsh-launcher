/**
 * The Run page's launch rail, as rendered before any IPC answer arrives (a
 * server-rendered view runs no effects, so this is exactly the initial state).
 *
 * What it pins is a SHAPE: the launch target used to be a DSH `<Select>` — one
 * control whose answer lived behind a click, with no room to say anything about
 * the install it pointed at. It is now a card list, and the page states where a
 * launch lands (it moves to 进程管理, it does not linger on the launcher).
 *
 * The tab switch itself is an effect and cannot be seen here; it is verified
 * against the running app instead.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '../i18n/locales/en'
import RunsSection from './RunsSection.tsx'

const render = (): string => renderToStaticMarkup(
  <I18nextProvider i18n={i18next}>
    <RunsSection />
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

describe('the run page launch rail', () => {
  it('names its scope and lists installs as cards, not as a dropdown', () => {
    const html = render()
    expect(html).toContain('DSH (0)')
    // The one control the rail is explicitly not supposed to be any more.
    expect(html).not.toContain('ant-select')
  })

  it('says where a launch lands', () => {
    expect(render()).toContain('jump to Processes')
  })

  it('opens on the launch tab with the processes tab beside it', () => {
    const html = render()
    expect(html).toContain('Launch')
    expect(html).toContain('Processes')
  })
})
