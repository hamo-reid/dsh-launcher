/**
 * The declaration model: the roster a profile's patch stack resolves to, and the
 * text-level writes that keep a declaration's `plugins` block bytes intact.
 */
import { describe, expect, it } from 'vitest'
import {
  declarationLoaderId, insertDeclaration, pluginsBlockOf, readDeclarations, removeDeclaration,
  renderDeclarationRow, saveDeclarationMeta, type ComposedLayer,
} from './declaration.ts'

/** One composed layer from lines. */
const layer = (kind: ComposedLayer['kind'], ...lines: string[]): ComposedLayer => ({
  kind,
  text: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
  path: `C:/layers/${kind}.cordis.patch.yml`,
  baseDir: `C:/layers/${kind}`,
  ...(kind === 'bundle' ? { bundle: '@deepseek-ai/dsh-web-app' } : {}),
})

/** One composed layer at its own path. Two layers of one KIND are two FILES —
 * which is the granularity a repeated insert is counted at. */
const layerFile = (kind: ComposedLayer['kind'], file: string, ...lines: string[]): ComposedLayer => ({
  kind,
  text: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
  path: `C:/layers/${file}`,
  baseDir: `C:/layers/${file.replace(/\.patch\.yml$/, '')}`,
  ...(kind === 'bundle' ? { bundle: '@deepseek-ai/dsh-web-app' } : {}),
})

/** A shipped-style declaration row, 4-space base indent like the real patches. */
const shipped = (id: string, order: number, ...extra: string[]): string[] => [
  '- insert:',
  `    - id: preset-${id}`,
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  `        id: ${id}`,
  `        order: ${order}`,
  '        plugins:',
  '          - id: persona',
  "            name: '@deepseek-ai/dsh-persona'",
  ...extra,
]

describe('readDeclarations', () => {
  it('reads every declaration in a layer stack, keyed by config.id', () => {
    const read = readDeclarations([
      layer('bundle', ...shipped('standard', 1), ...shipped('minimal', 3)),
      layer('profile'),
      layer('home'),
    ])
    expect(read.warnings).toEqual([])
    expect(read.presets.map(p => p.id)).toEqual(['standard', 'minimal'])
    expect(read.presets[0]).toMatchObject({
      id: 'standard',
      rowId: 'preset-standard',
      layer: 'bundle',
      bundle: '@deepseek-ai/dsh-web-app',
      order: 1,
      sourcePath: 'C:/layers/bundle.cordis.patch.yml',
      baseDir: 'C:/layers/bundle',
    })
    expect(read.presets[0].read.ok).toBe(true)
  })

  it('sorts by order then id, and treats a missing order as last', () => {
    const read = readDeclarations([
      layer('profile',
        '- insert:',
        '    - id: local-preset-zeta',
        "      name: '@deepseek-ai/dsh-agent-preset'",
        '      config:',
        '        id: zeta',
        '        order: 5',
        '        plugins: []',
        '    - id: local-preset-alpha',
        "      name: '@deepseek-ai/dsh-agent-preset'",
        '      config:',
        '        id: alpha',
        '        plugins: []',
        '    - id: local-preset-beta',
        "      name: '@deepseek-ai/dsh-agent-preset'",
        '      config:',
        '        id: beta',
        '        plugins: []',
        '    - id: local-preset-gamma',
        "      name: '@deepseek-ai/dsh-agent-preset'",
        '      config:',
        '        id: gamma',
        '        order: 5',
        '        plugins: []'),
    ])
    // order 5 first (id breaks the tie), then the declarations that state none.
    expect(read.presets.map(p => p.id)).toEqual(['gamma', 'zeta', 'alpha', 'beta'])
  })

  it('lets a later layer replace the whole config of a loader row', () => {
    const read = readDeclarations([
      layer('bundle', ...shipped('standard', 1)),
      layer('profile',
        '- id: preset-standard',
        "  name: '@deepseek-ai/dsh-agent-preset'",
        '  config:',
        '    id: standard',
        '    order: 9',
        '    name: My standard',
        '    plugins:',
        '      - id: only',
        "        name: '@deepseek-ai/dsh-tool-bash'"),
    ])
    expect(read.presets).toHaveLength(1)
    expect(read.presets[0]).toMatchObject({ id: 'standard', layer: 'profile', order: 9, name: 'My standard' })
    expect(read.presets[0].read.ok && read.presets[0].read.rows.map(r => r.name))
      .toEqual(['@deepseek-ai/dsh-tool-bash'])
  })

  it('honours a `disabled: true` override from a later layer', () => {
    const read = readDeclarations([
      layer('bundle', ...shipped('standard', 1), ...shipped('ptc', 2)),
      layer('profile', '- id: preset-standard', '  disabled: true'),
    ])
    expect(read.presets.map(p => p.id)).toEqual(['ptc'])
  })

  it('honours `disabled: false` written after a disable', () => {
    const read = readDeclarations([
      layer('bundle', ...shipped('standard', 1)),
      layer('profile', '- id: preset-standard', '  disabled: true'),
      layer('home', '- id: preset-standard', '  disabled: false'),
    ])
    expect(read.presets.map(p => p.id)).toEqual(['standard'])
  })

  it('is not fooled by a `disabled: true` on a row nested in a declaration', () => {
    const read = readDeclarations([
      layer('bundle', ...shipped('standard', 1,
        '          - id: tool-subagent-codex',
        "            name: '@deepseek-ai/dsh-tool-subagent'",
        '            disabled: true')),
    ])
    expect(read.presets.map(p => p.id)).toEqual(['standard'])
    expect(read.presets[0].read.ok && read.presets[0].read.rows.map(r => r.skipped)).toEqual([false, true])
  })

  it('reports a preset id declared twice instead of listing it twice', () => {
    const read = readDeclarations([
      layer('bundle', ...shipped('standard', 1)),
      layer('profile',
        '- insert:',
        '    - id: local-preset-standard',
        "      name: '@deepseek-ai/dsh-agent-preset'",
        '      config:',
        '        id: standard',
        '        plugins: []'),
    ])
    expect(read.presets.map(p => p.id)).toEqual(['standard'])
    expect(read.presets[0].layer).toBe('bundle')
    expect(read.warnings).toHaveLength(1)
    expect(read.warnings[0]).toContain('declared twice')
    expect(read.warnings[0]).toContain('Duplicate agent preset: standard')
  })

  it('warns when two layers INSERT the same loader row id, which dsh refuses to boot for', () => {
    // Folding cannot tell this from the replace it exists for — a later layer
    // saying the same row id again — so the roster silently keeps one row, and
    // only this warning says the profile will not start.
    const read = readDeclarations([
      layerFile('bundle', 'web.patch.yml', ...shipped('standard', 1)),
      layerFile('profile', 'mine.patch.yml',
        '- insert:',
        '    - id: preset-standard',
        "      name: '@deepseek-ai/dsh-agent-preset'",
        '      config:',
        '        id: standard',
        '        plugins: []'),
    ])
    expect(read.presets.map(p => p.id)).toEqual(['standard'])
    expect(read.warnings).toHaveLength(1)
    expect(read.warnings[0]).toContain('preset-standard')
    expect(read.warnings[0]).toContain('2 times')
    expect(read.warnings[0]).toContain('web.patch.yml')
    expect(read.warnings[0]).toContain('mine.patch.yml')
    expect(read.warnings[0]).toContain('duplicate loader entry id')
  })

  it('does not read a later layer naming a row id as inserting it', () => {
    // A row that only names the id changes that row; it adds no entry, so it
    // cannot collide. This is the same distinction the create guard rests on.
    const read = readDeclarations([
      layerFile('bundle', 'web.patch.yml', ...shipped('standard', 1)),
      layerFile('home', 'home.patch.yml', '- id: preset-standard', '  disabled: false'),
    ])
    expect(read.presets.map(p => p.id)).toEqual(['standard'])
    expect(read.warnings).toEqual([])
  })

  it('says nothing about an insert conflict outside the preset roster', () => {
    // Two layers inserting one PLUGIN row is the profile page's finding. Naming
    // it here too would report rows this page never shows.
    const read = readDeclarations([
      layerFile('bundle', 'web.patch.yml', '- insert:', '    - id: tool-bash', "      name: '@x/tool-bash'"),
      layerFile('profile', 'mine.patch.yml', '- insert:', '    - id: tool-bash', "      name: '@x/tool-bash'"),
    ])
    expect(read).toEqual({ presets: [], warnings: [] })
  })

  it('lets a preset keep its id when a nameless row borrowed the loader row id as one', () => {
    // The broken row comes FIRST and its borrowed id IS `standard`. First come
    // first served would hand it the slot and drop the preset that works — for a
    // preset id, which is a question about identities, not about row ids.
    const read = readDeclarations([
      layerFile('bundle', 'web.patch.yml',
        '- insert:',
        '    - id: standard',
        "      name: '@deepseek-ai/dsh-agent-preset'",
        '      config:',
        '        plugins: []'),
      layerFile('profile', 'mine.patch.yml', ...shipped('standard', 2)),
    ])
    const working = read.presets.filter(p => p.broken === undefined)
    expect(working.map(p => [p.id, p.rowId, p.order])).toEqual([['standard', 'preset-standard', 2]])
    // And the row that borrowed the id is still shown, with its own reason.
    expect(read.presets).toHaveLength(2)
    expect(read.presets.filter(p => p.broken !== undefined)[0].broken).toContain('config.id')
    expect(read.warnings).toEqual([])
  })

  it('marks a `config.id` the host would reject instead of listing it as a preset', () => {
    const read = readDeclarations([layer('profile',
      '- insert:',
      '    - id: local-preset-bad',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: Bad_ID',
      '        plugins: []')])
    expect(read.presets).toHaveLength(1)
    // The file's own spelling is still what the page shows.
    expect(read.presets[0].id).toBe('Bad_ID')
    expect(read.presets[0].broken).toContain('not a preset id the host accepts')
  })

  it('keeps a broken declaration on the roster with the reason', () => {
    const read = readDeclarations([layer('profile',
      '- insert:',
      '    - id: local-preset-noid',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        plugins: []',
      '    - id: local-preset-noconfig',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '    - id: local-preset-badshape',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: badshape',
      '        plugins: nope',
      '    - id: local-preset-badorder',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: badorder',
      '        order: soon',
      '        plugins: []')])
    const byId = new Map(read.presets.map(p => [p.id, p.broken]))
    expect(byId.get('local-preset-noid')).toContain('config.id')
    expect(byId.get('local-preset-noconfig')).toContain('no `config` map')
    expect(byId.get('badshape')).toBe('the composition must be a top-level list of plugin rows')
    expect(byId.get('badorder')).toContain('`order` is not a number')
  })

  it('accepts a `!!js` value in a scalar the loader decides, and a `cordis:group` row nested in plugins', () => {
    const read = readDeclarations([layer('profile',
      '- insert:',
      '    - id: local-preset-gated',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: gated',
      "        name: !!js process.env.PRESET_NAME ?? 'Gated'",
      '        order: !!js process.env.N',
      '        plugins:',
      '          - id: shell',
      '            name: cordis:group',
      '            group: true',
      '            config:',
      '              - id: pty',
      "                name: '@deepseek-ai/dsh-terminal'")])
    expect(read.presets[0].broken).toBeUndefined()
    expect(read.presets[0].read.ok && read.presets[0].read.rows.map(r => r.name))
      .toEqual(['@deepseek-ai/dsh-terminal'])
  })

  it('drops a declaration whose config body is not valid YAML, with the parser reason', () => {
    const read = readDeclarations([layer('profile',
      '- insert:',
      '    - id: local-preset-broken',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: broken',
      '        plugins: [')])
    expect(read.presets[0].broken).toBeTruthy()
  })

  it('returns an empty roster for a stack with no declaration rows', () => {
    expect(readDeclarations([layer('bundle', '- id: tool-bash', "  name: '@x/tool-bash'")]))
      .toEqual({ presets: [], warnings: [] })
  })
})

describe('declarationLoaderId', () => {
  it('namespaces the launcher\'s rows away from the shipped `preset-<id>` convention', () => {
    expect(declarationLoaderId('review')).toBe('local-preset-review')
  })
})

describe('pluginsBlockOf', () => {
  it('slices the plugins block verbatim, block scalars and !!js included', () => {
    const body = [
      'id: mine',
      'name: Mine',
      'plugins:',
      '  - id: gate',
      "    name: '@deepseek-ai/dsh-tool-bash'",
      "    disabled: !!js process.platform === 'win32'",
      '  - id: pty',
      "    name: '@deepseek-ai/dsh-terminal'",
      '    config:',
      '      description: |-',
      '        line one',
      '        line two',
    ].join('\n')
    expect(pluginsBlockOf(body)).toBe(body.split('\n').slice(2).join('\n'))
  })

  it('stops at the next config key and reports no block when there is none', () => {
    expect(pluginsBlockOf('id: a\nplugins: []\norder: 2')).toBe('plugins: []')
    expect(pluginsBlockOf('id: a\norder: 2')).toBeUndefined()
  })
})

describe('renderDeclarationRow', () => {
  it('writes a row the host accepts, copying the plugin block verbatim', () => {
    const plugins = [
      'plugins:',
      '  - id: persona',
      "    name: '@deepseek-ai/dsh-persona'",
      "    disabled: !!js process.platform === 'win32'",
      '  - id: shell',
      '    config:',
      '      description: |-',
      '        keep me',
    ].join('\n')
    expect(renderDeclarationRow({ id: 'review', name: 'Review', description: 'Only bash.', order: 10, pluginsBlock: plugins }))
      .toEqual([
        '    - id: local-preset-review',
        "      name: '@deepseek-ai/dsh-agent-preset'",
        '      config:',
        '        id: review',
        '        name: Review',
        '        description: Only bash.',
        '        order: 10',
        '        plugins:',
        '          - id: persona',
        "            name: '@deepseek-ai/dsh-persona'",
        "            disabled: !!js process.platform === 'win32'",
        '          - id: shell',
        '            config:',
        '              description: |-',
        '                keep me',
      ])
  })

  it('quotes what YAML would misread and omits the display keys it was not given', () => {
    const lines = renderDeclarationRow({ id: 'x', description: 'uses: colons', pluginsBlock: 'plugins: []' })
    expect(lines).toEqual([
      '    - id: local-preset-x',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: x',
      "        description: 'uses: colons'",
      '        plugins: []',
    ])
  })
})

describe('insertDeclaration / removeDeclaration', () => {
  it('creates the insert block when the patch has none, replacing the `[]` marker', () => {
    const out = insertDeclaration('[]\n', { id: 'review', pluginsBlock: 'plugins: []' })
    expect(out).toContain('- insert:')
    expect(out).toContain('    - id: local-preset-review')
    expect(out).not.toContain('[]\n- insert')
  })

  it('appends beside existing children and removes cleanly', () => {
    const withMcp = [
      '- insert:',
      '    - id: mcp-codegraph',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: codegraph',
      '',
    ].join('\n')
    const added = insertDeclaration(withMcp, { id: 'review', pluginsBlock: 'plugins: []' })
    expect(added.indexOf('mcp-codegraph')).toBeLessThan(added.indexOf('local-preset-review'))
    const dropped = removeDeclaration(added, 'local-preset-review')
    expect(dropped).toContain('mcp-codegraph')
    expect(dropped).not.toContain('local-preset-review')
    expect(removeDeclaration(added, 'mcp-codegraph')).not.toContain('mcp-codegraph')
  })

  it('drops the owning `- insert:` header when the last child goes', () => {
    const only = insertDeclaration('', { id: 'review', pluginsBlock: 'plugins: []' })
    expect(removeDeclaration(only, 'local-preset-review').trim()).toBe('')
  })
})

describe('saveDeclarationMeta', () => {
  const document = insertDeclaration(
    '- insert:\n    - id: mcp-codegraph\n      name: \'@deepseek-ai/dsh-mcp-client\'\n      config:\n        serverName: codegraph\n',
    { id: 'review', name: 'Review', description: 'Only bash.', order: 10, pluginsBlock: 'plugins:\n  - id: gate\n    disabled: !!js x' },
  )
  /** The declaration's plugin rows, exactly as {@link insertDeclaration} wrote them. */
  const PLUGINS = '        plugins:\n          - id: gate\n            disabled: !!js x'

  it('updates the scalars and leaves the plugins block byte-identical', () => {
    expect(document).toContain(PLUGINS)
    const next = saveDeclarationMeta(document, 'local-preset-review', { name: 'Renamed', description: '', order: 2 })
    expect(next).toContain('        name: Renamed')
    expect(next).toContain('        order: 2')
    expect(next).not.toContain('Only bash.')
    expect(next).toContain(PLUGINS)
    expect(next).toContain('mcp-codegraph')
  })

  it('clears order without leaving a null key behind', () => {
    const next = saveDeclarationMeta(document, 'local-preset-review', { name: 'Review', description: 'Only bash.', order: null })
    expect(next).not.toContain('        order:')
    expect(next).toContain(PLUGINS)
  })
})
