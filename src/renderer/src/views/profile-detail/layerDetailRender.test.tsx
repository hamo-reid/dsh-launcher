/**
 * The layer modal's two panes, rendered directly.
 *
 * `LayerDetail` itself is not rendered here: its data arrives through IPC in an
 * effect, which a server-rendered test never runs. What is asserted is therefore
 * the two presentational halves, and specifically the rule that governs them — the
 * actions a row offers are the LAYER's, not a preference. A shipped (bundle) row
 * can only be covered into the profile layer, a home row can only be toggled, and
 * only the profile's own row can be rewritten or dropped. Getting that wrong would
 * offer an edit the write path then refuses.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '../../i18n/locales/en'
import LayerDetail, { RowCard, RowDetail, RowEditor } from './LayerDetail.tsx'
import { rowActionsOf } from '../../lib/profileLayers.ts'
import type { ClassifiedRow, ProfileLayer } from '../../../../shared/types.ts'

const row = (over: Partial<ClassifiedRow> = {}): ClassifiedRow =>
  ({ id: 'web-ui', disabled: false, hasConfig: false, hasInsert: false, ...over })
const layerOf = (source: ProfileLayer['source'], bundle?: string): ProfileLayer =>
  ({ source, ...(bundle === undefined ? {} : { bundle }), files: [] })

/** The action buttons one pane rendered, in order. Empty labels are dropped: the
 * search box's clear affordance is a button with no text. */
const buttons = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>(?:<span[^>]*>)?([^<]*)/g)].map(m => m[1].trim()).filter(label => label !== '')

const card = (r: ClassifiedRow, override?: string): string => renderToStaticMarkup(
  <I18nextProvider i18n={i18next}>
    <RowCard row={r} selected={false} override={override} onSelect={() => {}} />
  </I18nextProvider>,
)

const detail = (
  r: ClassifiedRow,
  layer: ProfileLayer,
  over: Partial<Parameters<typeof RowDetail>[0]> = {},
): string => renderToStaticMarkup(
  <I18nextProvider i18n={i18next}>
    <RowDetail
      row={r}
      actions={rowActionsOf(layer)}
      config={null}
      configLoading={false}
      onToggle={() => {}}
      onCover={() => {}}
      onEdit={() => {}}
      onRemoveCover={() => {}}
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

describe('a row in the layer list', () => {
  it('names the row by its display name, falling back to its id', () => {
    expect(card(row({ name: 'Web UI' }))).toContain('Web UI')
    expect(card(row())).toContain('web-ui')
  })

  it('says a row is overridden — without naming the layer in the narrow list', () => {
    const html = card(row({ disabled: true, hasConfig: true, hasInsert: true }), 'base')
    expect(html).toContain('disabled')
    expect(html).toContain('>config<')
    expect(html).toContain('>insert<')
    expect(html).toContain('overridden')
    // The layer label is a long bundle path; the pane, which has the room, names it.
    expect(html).not.toContain('overridden by base')
  })

  it('says enabled — and claims nothing else — for a plain row', () => {
    const html = card(row())
    expect(html).toContain('enabled')
    expect(html).not.toContain('>config<')
    expect(html).not.toContain('>insert<')
    expect(html).not.toContain('overridden')
  })
})

describe('the layer list header', () => {
  const twoFile = (): ProfileLayer => ({
    source: 'bundle',
    bundle: '@deepseek-ai/dsh-web-app',
    files: [
      { file: 'cordis.patch.yml', rows: [row({ id: 'web-ui', name: 'Web UI' }), row({ id: 'ws-server' })] },
      { file: 'presets/standard.patch.yml', rows: [row({ id: 'timer' }), row({ id: 'combo' })] },
    ],
  })
  const render = (layer: ProfileLayer, over: Partial<Parameters<typeof LayerDetail>[0]> = {}): string => renderToStaticMarkup(
    <I18nextProvider i18n={i18next}>
      <LayerDetail
        layer={layer}
        lastSeen={new Map()}
        dshId="a"
        name="base"
        onToggle={() => {}}
        onCover={() => {}}
        onRemoveCover={() => {}}
        onSaved={() => {}}
        {...over}
      />
    </I18nextProvider>,
  )

  it('counts the rows above the list', () => {
    expect(render(twoFile())).toContain('4 row(s)')
  })

  it('offers a search box, and groups the rows by the file that serves them', () => {
    const html = render(twoFile())
    expect(html).toContain('placeholder="Search id or name"')
    expect(html).toContain('cordis.patch.yml')
    expect(html).toContain('presets/standard.patch.yml')
  })

  it('shows the first row in the pane, so the modal is never half empty', () => {
    const html = render(twoFile())
    expect(html).toContain('Web UI')
    // The bundle's only action, from the row the pane opened on.
    expect(buttons(html)).toEqual(['Override'])
  })

  it('offers the add-row entry only on the layer that can gain rows', () => {
    // Even with the parent offering it, a layer that cannot gain a row says nothing.
    expect(render(twoFile(), { onNewRow: () => {} })).not.toContain('+ Add row')
    expect(render({ ...twoFile(), source: 'profile', label: 'base' }, { onNewRow: () => {} })).toContain('+ Add row')
  })
})

describe('the actions a row pane offers', () => {
  it('offers a bundle row exactly one action: covering it into the profile layer', () => {
    expect(buttons(detail(row(), layerOf('bundle', 'base')))).toEqual(['Override'])
  })

  it('names the overriding layer in the pane, where there is room for it', () => {
    expect(detail(row(), layerOf('profile'), { override: 'home · machine-level' }))
      .toContain('overridden by home · machine-level')
  })

  it('offers a home row exactly one action: toggling it', () => {
    expect(buttons(detail(row(), layerOf('home')))).toEqual(['Disable'])
    // A disabled home row offers the way back.
    expect(buttons(detail(row({ disabled: true }), layerOf('home')))).toEqual(['Enable'])
  })

  it('offers the profile\'s own row the editable set, and no cover', () => {
    expect(buttons(detail(row(), layerOf('profile')))).toEqual(['Disable', 'Config', 'Insert', 'Delete'])
  })
})

describe('the config a row pane shows', () => {
  it('shows the shipped default and this profile\'s override under their owners', () => {
    const html = detail(row({ hasConfig: true }), layerOf('profile'), {
      config: { default: 'port: 8080', current: 'port: 9090' },
    })
    expect(html).toContain('Default (bundle)')
    expect(html).toContain('This profile’s override')
    expect(html).toContain('port: 8080')
    expect(html).toContain('port: 9090')
  })

  it('says so when the row carries none, rather than showing an empty box', () => {
    const html = detail(row(), layerOf('profile'), { config: { default: '', current: '' } })
    expect(html).toContain('(this row has no config)')
  })

  it('waits rather than claiming there is none while the read is in flight', () => {
    const html = detail(row({ hasConfig: true }), layerOf('profile'), { config: null, configLoading: true })
    expect(html).toContain('ant-spin')
    expect(html).not.toContain('(this row has no config)')
  })

  it('warns that an insert list is replaced whole, since it cannot be shown', () => {
    expect(detail(row({ hasInsert: true }), layerOf('profile'))).toContain('carries an insert list')
  })
})

describe('the editor the pane opens in place of the detail', () => {
  const editor = (kind: 'config' | 'insert', over: Partial<Parameters<typeof RowEditor>[0]> = {}): string =>
    renderToStaticMarkup(
      <I18nextProvider i18n={i18next}>
        <RowEditor
          kind={kind}
          row={row()}
          defaultText="port: 8080"
          initial="port: 9090"
          saving={false}
          onBack={() => {}}
          onSave={() => {}}
          {...over}
        />
      </I18nextProvider>,
    )

  it('replaces the view with the editor and a way back', () => {
    const html = editor('config')
    expect(html).toContain('Back')
    expect(html).toContain('config override · web-ui')
    expect(html).toContain('Save')
  })

  it('keeps what is being replaced on screen, beside the editable draft', () => {
    const html = editor('config')
    expect(html).toContain('Default (bundle)')
    expect(html).toContain('port: 8080')
    // The draft starts from what this layer already has, not from the default.
    expect(html).toContain('port: 9090')
    expect(html).toContain('<textarea')
    // ...and the rule that makes the flagged lines mean something.
    expect(html).toContain('full replacement')
  })

  it('flags the default\'s lines the draft drops', () => {
    // An override is a full replacement, so what it removes has to be visible.
    expect(editor('config')).toContain('rgba(255,77,79,0.16)')
  })

  it('says an insert list is replaced whole, and shows no bundle default there', () => {
    const html = editor('insert', { defaultText: '', initial: '' })
    expect(html).toContain('replaces this row')
    expect(html).not.toContain('Default (bundle)')
  })

  it('names the overriding layer when a write would raise the row\'s priority', () => {
    expect(editor('config', { override: 'home · machine-level' })).toContain('higher-priority layer')
  })
})
