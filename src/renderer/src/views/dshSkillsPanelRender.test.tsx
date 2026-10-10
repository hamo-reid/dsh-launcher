/**
 * What the dsh skills panel shows before anything is selected: its profile scope,
 * its authoring entrances, and its loading state.
 *
 * A preset contributes skill roots only inside a profile's composition, so "no
 * profile" is a state the page has to STATE — the defect it fixes was a panel that
 * silently listed fewer roots because the page never passed a profile at all.
 *
 * Server-rendered on purpose: effects do not run, which is exactly the initial
 * state under test (nothing selected, first read in flight). `window.api` is
 * therefore never touched — no IPC mock is needed for this assertion.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '../i18n/locales/en'
import SkillsManagePanel, { RootsBlock } from './SkillsManagePanel.tsx'
import type { SkillRootInfo } from '../../../shared/types.ts'

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

  it('carries the authoring actions', () => {
    const html = render()
    expect(html).toContain('New skill')
    expect(html).toContain('Import ZIP')
    expect(html).toContain('Install from library')
  })

  it('opens on a skeleton rather than an empty box or a premature "no skills"', () => {
    const html = render()
    // The first read is in flight, so the body shows the shape that is coming.
    expect(html).toContain('ant-skeleton')
    expect(html).not.toContain('No skills discovered on this dsh yet')
    // The import gesture belongs to the PANEL, not to a block of its own: no
    // always-visible dashed box spends the body on a hint that only applies mid-drag.
    expect(html).not.toContain('Drop a zip here to import')
  })
})

describe('the scanned-roots block', () => {
  const root = (over: Partial<SkillRootInfo> = {}): SkillRootInfo => ({
    root: 'user-dsh', source: 'user-dsh', rank: 400, path: 'C:/dsh/skills', exists: true, writable: true, ...over,
  })

  const block = (roots: SkillRootInfo[]): string => renderToStaticMarkup(
    <I18nextProvider i18n={i18next}>
      <RootsBlock roots={roots} />
    </I18nextProvider>,
  )

  it('names a preset root once, by its owner, instead of twice', () => {
    const html = block([root({ root: 'preset:cordis', source: 'preset', path: 'C:/presets/cordis/skills', writable: false })])
    expect(html).toContain('From preset &quot;cordis&quot;')
    // The generic label beside it would be the same fact a second time.
    expect(html).not.toContain('From a preset')
  })

  it('keeps the run-time tag where the path is an expression, not a path', () => {
    const html = block([
      root(),
      root({ root: 'runtime:0', source: 'custom', path: 'new URL("skills/", base)', exists: false, writable: false, runtime: true }),
    ])
    expect(html).toContain('This dsh')
    expect(html).toContain('Resolved at run time')
    expect(html).toContain('C:/dsh/skills')
  })
})
