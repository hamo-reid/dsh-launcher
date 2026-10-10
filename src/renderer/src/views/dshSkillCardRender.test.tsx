/**
 * What one skill's card says on the dsh panel: where the copy comes from, what the
 * library thinks of it, and which actions this copy may offer.
 *
 * Rendering goes through `react-dom/server` (already a dependency — no DOM, no
 * test-only renderer). Two things are deliberately not asserted: the kebab's menu
 * items (an antd `Dropdown` renders through a portal, so they are absent here) and
 * the problem tag's tooltip (rendered on hover) — the reason reaches the page as the
 * tag's tooltip, and `skillInstallRender.test.tsx` pins the tag itself.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '../i18n/locales/en'
import DshSkillCard from './DshSkillCard.tsx'
import type { SkillEntry, SkillLibInstall } from '../../../shared/types.ts'

const entry = (over: Partial<SkillEntry> = {}): SkillEntry => ({
  name: 'notes',
  description: 'Writes notes.',
  modelInvocable: true,
  userInvocable: true,
  source: 'user-dsh',
  rank: 400,
  path: 'C:/dsh/skills/notes/SKILL.md',
  dir: 'C:/dsh/skills/notes',
  shape: 'bundle',
  editable: true,
  ...over,
})

const cell = (over: Partial<SkillLibInstall> = {}): SkillLibInstall => ({
  dshId: 'a', dshName: 'dsh@a', installed: true, stale: false, ...over,
})

const card = (skill: SkillEntry, install: SkillLibInstall | undefined): string =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18next}>
      <DshSkillCard
        entry={skill}
        cell={install}
        busy={null}
        onEdit={() => undefined}
        onReinstall={() => undefined}
        onDelete={() => undefined}
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

describe('a skill card on the dsh panel', () => {
  it('reads its copy as its own source, and carries the body of the skill', () => {
    const html = card(entry(), undefined)
    // The words for a source must be the same wherever the source appears: the
    // copy in the dsh's own root is not "personal", it is THIS dsh's.
    expect(html).toContain('This dsh')
    expect(html).not.toContain('Personal')
    expect(html).toContain('Writes notes.')
    expect(html).toContain('C:/dsh/skills/notes/SKILL.md')
    // No verdict from the library means no verdict on the card.
    expect(html).not.toContain('Library has updates')
    expect(html).not.toContain('Up to date')
  })

  it('names the machine-wide agents root differently from this dsh', () => {
    const html = card(entry({ source: 'user-agents', editable: false }), undefined)
    expect(html).toContain('Machine agents')
    expect(html).not.toContain('>This dsh<')
  })

  it('offers editing only where the copy may be edited', () => {
    const mine = card(entry(), undefined)
    expect(mine).toContain('Edit')
    // A read-only root contributes a skill the panel can show but not change.
    const foreign = card(entry({ source: 'preset', editable: false }), undefined)
    expect(foreign).not.toContain('Edit')
    expect(foreign).toContain('From a preset')
  })

  it('flags a stale copy with the one action that addresses it', () => {
    const html = card(entry(), cell({ stale: true }))
    expect(html).toContain('Library has updates')
    expect(html).toContain('Reinstall')
  })

  it('reads an unreadable copy as unreadable, never as out of date', () => {
    const html = card(entry(), cell({ stale: true, problem: 'EISDIR' }))
    expect(html).toContain('Unreadable (1)')
    expect(html).not.toContain('Library has updates')
    expect(html).not.toContain('Up to date')
  })
})
