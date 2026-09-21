/**
 * Dev-plugin resolution index: the id → package map parsed out of the layers a
 * target composes, and the package part of an import spec.
 *
 * The load-bearing property is that the map is PARSED, not assembled: on a real
 * install `tool-bash` names `@deepseek-ai/dsh-tool-bash` but `timer` names
 * `@deepseek-ai/cordis-plugin-timer`, so no prefix rule can derive it.
 */
import { describe, expect, it } from 'vitest'
import { buildModuleIndex, packageOf, type ModuleIndexRow } from './module-index.ts'

const row = (id: string, name: string, source: string): ModuleIndexRow => ({ id, name, source })

describe('packageOf', () => {
  it('keeps a bare name and strips a subpath', () => {
    expect(packageOf('hono')).toBe('hono')
    expect(packageOf('dsh-base/sub/x')).toBe('dsh-base')
  })

  it('keeps both segments of a scoped name', () => {
    expect(packageOf('@deepseek-ai/dsh-tool-bash')).toBe('@deepseek-ai/dsh-tool-bash')
    expect(packageOf('@deepseek-ai/dsh-web-app/startup')).toBe('@deepseek-ai/dsh-web-app')
    expect(packageOf('@deepseek-ai/dsh-tool-subagent/model-selection-settings')).toBe('@deepseek-ai/dsh-tool-subagent')
  })

  it('tolerates trailing slashes and whitespace', () => {
    expect(packageOf('  @s/p/  ')).toBe('@s/p')
    expect(packageOf('@scope')).toBe('@scope')
  })
})

describe('buildModuleIndex', () => {
  it('binds an id to the package its declaring row names', () => {
    const info = buildModuleIndex([
      row('tool-bash', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-base'),
      row('timer', '@deepseek-ai/cordis-plugin-timer', '@deepseek-ai/dsh-base'),
    ], 'main')
    expect(info.bindings).toEqual([
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', source: '@deepseek-ai/dsh-base' },
      { id: 'timer', name: '@deepseek-ai/cordis-plugin-timer', source: '@deepseek-ai/dsh-base' },
    ])
    expect(info.profile).toBe('main')
    expect(info.conflicts).toEqual([])
    expect(info.layers).toEqual([{ source: '@deepseek-ai/dsh-base', rows: 2 }])
  })

  it('takes the first layer to name an id, mirroring the host’s insert', () => {
    const info = buildModuleIndex([
      row('web', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base'),
      row('web', '@drahamo/hamo-app', '@drahamo/hamo-app'),
    ])
    expect(info.bindings).toEqual([{ id: 'web', name: '@deepseek-ai/dsh-web-app', source: '@deepseek-ai/dsh-base' }])
  })

  it('reports an id two layers name differently — the host’s hard failure', () => {
    const info = buildModuleIndex([
      row('layout', '@deepseek-ai/dsh-ui-layout', '@deepseek-ai/dsh-base'),
      row('layout', '@drahamo/hamo-ui-layout', '@drahamo/hamo-app'),
    ])
    expect(info.conflicts).toEqual([{
      id: 'layout',
      names: ['@deepseek-ai/dsh-ui-layout', '@drahamo/hamo-ui-layout'],
      sources: ['@deepseek-ai/dsh-base', '@drahamo/hamo-app'],
    }])
  })

  it('does not treat a re-statement of the same name as a conflict', () => {
    const info = buildModuleIndex([
      row('web', '@deepseek-ai/dsh-web-app', 'a'),
      row('web', '@deepseek-ai/dsh-web-app', 'b'),
    ])
    expect(info.conflicts).toEqual([])
  })

  it('treats a name-less row as a lookup, never as a binding', () => {
    const info = buildModuleIndex([
      row('tool-bash', '', '@drahamo/hamo-app'),
      row('tool-bash', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-base'),
    ])
    expect(info.bindings).toEqual([
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', source: '@deepseek-ai/dsh-base' },
    ])
    // …but a name-less row still counts as a row of its layer.
    expect(info.layers).toEqual([
      { source: '@drahamo/hamo-app', rows: 1 },
      { source: '@deepseek-ai/dsh-base', rows: 1 },
    ])
  })

  it('keeps unscoped names', () => {
    const info = buildModuleIndex([row('left-pad', 'left-pad', 'home')])
    expect(info.bindings[0]).toEqual({ id: 'left-pad', name: 'left-pad', source: 'home' })
  })
})
