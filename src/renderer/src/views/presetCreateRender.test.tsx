/**
 * The one thing a logic-only test cannot show about the "new preset" dialog: the
 * "already taken" line the person actually reads.
 *
 * The dialog itself renders through a portal, so nothing inside it exists in a
 * server render — its body is its own component for that reason (the same split
 * `InstallSkillFields` uses). The submit button is in the modal's footer and is
 * therefore NOT asserted here; whether it is disabled is a pure decision, pinned
 * in `lib/presetCreate.test.ts`.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '../i18n/locales/en'
import { PresetCreateFields, type PresetCreateFieldsProps } from './presets/PresetModals.tsx'

const render = (over: Partial<PresetCreateFieldsProps> = {}): string => renderToStaticMarkup(
  <I18nextProvider i18n={i18next}>
    <PresetCreateFields
      mode="copy"
      onMode={() => undefined}
      minimalId="minimal"
      presets={[{ id: 'minimal', trust: 'system', source: 'bundle', editable: false, location: 'C:/p.yml', locationKind: 'file' }]}
      fromId="minimal"
      onFromId={() => undefined}
      toId=""
      onToId={() => undefined}
      name=""
      onName={() => undefined}
      blocker={null}
      {...over}
    />
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

describe('the new-preset dialog body', () => {
  it('says an id is taken when the draft is blocked for that reason', () => {
    // What the modal passes down when the id is in the set the page built from
    // the roster AND the kept directories.
    const html = render({ toId: 'liangshen', blocker: 'That preset id is already taken.' })
    expect(html).toContain('liangshen')
    expect(html).toContain('That preset id is already taken.')
  })

  it('shows the id rule instead when the draft is malformed', () => {
    const html = render({ toId: 'Bad_ID', blocker: 'Unusable preset id.' })
    expect(html).toContain('Unusable preset id.')
    expect(html).not.toContain('already taken')
  })

  it('says nothing extra about a draft that is fine', () => {
    const html = render({ toId: 'review' })
    expect(html).not.toContain('already taken')
    expect(html).not.toContain('Unusable preset id.')
  })
})
