/**
 * The preset contents view: what one preset is made of, and what those rows
 * amount to under the profile the page is showing.
 *
 * `PresetDetailModal` itself is not rendered here — an antd `Modal` goes through a
 * portal, so its body does not exist in a server render. The exported body is the
 * thing under test, which is also where the classification has to be visible: the
 * four sections ARE the answer to "why is this preset not usable here".
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '../../i18n/locales/en'
import { PresetDetailBody } from './PresetDetailModal.tsx'
import type {
  PresetCompositionRow, PresetGrade, PresetListItem,
} from '../../../../shared/types.ts'

const preset = (over: Partial<PresetListItem> = {}): PresetListItem => ({
  id: 'standard',
  trust: 'system',
  source: 'bundle',
  bundle: '@deepseek-ai/dsh-web-app',
  order: 1,
  editable: false,
  location: 'C:/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml',
  locationKind: 'file',
  rowId: 'preset-standard',
  ...over,
})

const grade = (over: Partial<PresetGrade> = {}): PresetGrade => ({
  presetId: 'standard',
  profile: 'base',
  level: 'ok',
  checked: 0,
  skipped: 0,
  conditional: 0,
  missing: [],
  rows: [],
  ...over,
})

const row = (over: Partial<PresetCompositionRow> = {}): PresetCompositionRow =>
  ({ label: 'row 1', name: '@acme/tool', kind: 'package', state: 'found', ...over })

const render = (p: PresetListItem, g: PresetGrade | undefined): string => renderToStaticMarkup(
  <I18nextProvider i18n={i18next}>
    <PresetDetailBody preset={p} grade={g} />
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

describe('the preset contents body', () => {
  it('says what the preset is and where it lives, loader row included', () => {
    const html = render(preset({ name: 'Standard mode' }), grade())
    expect(html).toContain('Standard mode')
    expect(html).toContain('>standard<')
    // The source tag, and the priority the host sorts by.
    expect(html).toContain('>bundle<')
    expect(html).toContain('Priority 1')
    expect(html).toContain('loader row preset-standard')
    expect(html).toContain('presets/standard.patch.yml')
  })

  it('falls back to the id, and says there is no description rather than nothing', () => {
    const html = render(preset(), grade())
    expect(html).toContain('>standard<')
    expect(html).toContain('(no description)')
  })

  it('reads the worst rows first, each with its count', () => {
    const html = render(preset(), grade({
      level: 'incomplete',
      checked: 3,
      skipped: 1,
      conditional: 1,
      missing: [{ label: 'row 2', name: '@acme/gone' }],
      rows: [
        row({ label: 'row 1', name: '@acme/tool', state: 'found' }),
        row({ label: 'row 2', name: '@acme/gone', state: 'missing' }),
        row({ label: 'row 3', name: 'cordis:group', kind: 'builtin', state: 'skipped' }),
        row({ label: 'row 4', name: '!!js pick()', kind: null, state: 'conditional' }),
        row({ label: 'row 5', name: './local.mjs', kind: 'preset', state: 'found' }),
      ],
    }))
    const order = [
      'Rows nothing resolves (1)',
      'Rows the runtime decides (1)',
      'Disabled rows (1)',
      'Rows that start (2)',
    ]
    expect(order.map(heading => html.indexOf(heading))).toEqual([...order.map(heading => html.indexOf(heading))].sort((a, b) => a - b))
    expect(order.every(heading => html.includes(heading))).toBe(true)
  })

  it('labels each row: what it resolves to, and where its specifier points', () => {
    const html = render(preset(), grade({
      rows: [
        row({ label: 'row 1', name: 'cordis:group', kind: 'builtin', state: 'found' }),
        row({ label: 'row 2', name: './local.mjs', kind: 'preset', state: 'found' }),
        row({ label: 'row 3', name: 'file:///abs/x.mjs', kind: 'file', state: 'missing' }),
        row({ label: 'row 4', name: '@acme/tool', kind: 'package', state: 'found' }),
      ],
    }))
    expect(html).toContain('builtin')
    expect(html).toContain('relative path')
    expect(html).toContain('>file<')
    expect(html).toContain('>package<')
    // The state tag is the verdict; the label is the host's own wording for where
    // the row sits.
    expect(html).toContain('not found')
    expect(html).toContain('row 3')
  })

  it('claims no kind for a !!js row, which has none to claim', () => {
    const html = render(preset(), grade({
      level: 'ok', conditional: 1,
      rows: [row({ label: 'row "gated"', name: '!!js pickTool()', kind: null, state: 'conditional' })],
    }))
    expect(html).toContain('runtime decides')
    expect(html).toContain('!!js pickTool()')
    expect(html).not.toContain('>package<')
  })

  it('explains an unusable preset instead of listing nothing', () => {
    const html = render(preset(), grade({
      level: 'unusable', reason: 'the declaration carries no `config` map',
    }))
    expect(html).toContain('the declaration carries no `config` map')
    expect(html).not.toContain('Rows that start')
  })

  it('says an empty composition is empty, not broken', () => {
    const html = render(preset(), grade({ level: 'ok', rows: [] }))
    expect(html).toContain('holds no rows')
    expect(html).not.toContain('Rows that start')
  })

  it('flays a borrowed identity, which is what the id in the roster came from', () => {
    const html = render(preset({ idFromRow: true, rowId: 'local-broken' }), grade())
    expect(html).toContain('borrowed from the loader row id')
  })

  it('never shows a row\'s config: that is plugin-private data', () => {
    // The payload cannot carry one (no field), and this view must not grow one
    // silently — a preset's `config` is the plugin's, not the launcher's to report.
    const html = render(preset(), grade({
      rows: [row({ name: '@acme/tool', state: 'found' }), row({ label: 'row 2', name: '@acme/gone', state: 'missing' })],
    }))
    expect(html).not.toContain('config')
  })

  it('says a preset has no grade yet rather than showing an empty list', () => {
    expect(render(preset(), undefined)).toContain('has not been graded')
  })
})
