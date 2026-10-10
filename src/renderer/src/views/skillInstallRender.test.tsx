/**
 * The one thing a screenshot would catch and a logic-only test otherwise cannot:
 * the REASON a copy cannot be read has to reach the page.
 *
 * Rendering goes through `react-dom/server` (already a dependency — no DOM, no
 * test-only renderer). Two targets are asserted: the library card's TAG, and the
 * install modal's BODY — the modal itself renders through a portal, so its content
 * does not exist in a server render, which is why the body is its own component.
 * Tooltips are deliberately not asserted: antd renders their content on hover.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '../i18n/locales/en'
import SkillCard from './SkillCard.tsx'
import { InstallSkillFields } from './LibraryModals.tsx'
import type { SkillLibEntry, SkillLibInstall } from '../../../shared/types.ts'

const ENTRY: SkillLibEntry = {
  name: 'notes',
  description: 'Writes notes.',
  modelInvocable: true,
  userInvocable: true,
  path: 'C:/lib/notes/SKILL.md',
  dir: 'C:/lib/notes',
}

const PROBLEM = 'the installed copy cannot be read: C:/dsh/skills/notes/SKILL.md (EISDIR)'
const SCOPES = [{ id: 'a', name: 'dsh@a', profiles: ['default'] }]

const cell = (over: Partial<SkillLibInstall> = {}): SkillLibInstall => ({
  dshId: 'a', dshName: 'dsh@a', installed: false, stale: false, ...over,
})

const render = (node: JSX.Element): string =>
  renderToStaticMarkup(<I18nextProvider i18n={i18next}>{node}</I18nextProvider>)

const fields = (current: SkillLibInstall | undefined): string => render(
  <InstallSkillFields
    scopes={SCOPES}
    dshId="a"
    onPickDsh={() => undefined}
    current={current}
    overwrite={false}
    onOverwrite={() => undefined}
  />,
)

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    resources: { en },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
})

describe('a cell that cannot be read', () => {
  it('is labelled on the library card instead of reading as a stale copy', () => {
    const html = render(
      <SkillCard
        entry={ENTRY}
        installs={[cell({ installed: true, stale: true, problem: PROBLEM })]}
        openBusy={false}
        onOpen={() => undefined}
        onInstall={() => undefined}
        onDelete={() => undefined}
      />,
    )
    expect(html).toContain('Unreadable (1)')
    // The verdict tags must not claim anything about being current.
    expect(html).not.toContain('Library has updates')
    expect(html).not.toContain('Up to date')
  })

  it('shows the reason itself in the install dialog, not just the stale verdict', () => {
    const html = fields(cell({ installed: true, stale: true, problem: PROBLEM }))
    expect(html).toContain('Cannot be read:')
    expect(html).toContain('EISDIR')
    expect(html).toContain('reinstalling usually cannot fix it')
    // Nothing about being current, and no overwrite consent for a copy we cannot
    // even read — that checkbox belongs to the up-to-date case.
    expect(html).not.toContain('behind the library')
    expect(html).not.toContain('Overwrite the installed copy')
  })

  it('still reads a plain stale copy as an update, with consent to overwrite', () => {
    const stale = fields(cell({ installed: true, stale: true }))
    expect(stale).toContain('behind the library')
    expect(stale).not.toContain('Cannot be read:')

    const current = fields(cell({ installed: true }))
    expect(current).toContain('tick overwrite to force a reinstall')
    expect(current).toContain('Overwrite the installed copy')
  })

  it('says nothing about a dsh that does not have the skill', () => {
    const html = fields(cell())
    expect(html).toContain('library skill directory into that dsh')
    expect(html).not.toContain('Cannot be read:')
  })
})
