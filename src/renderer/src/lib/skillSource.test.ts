/** What a scanned root wears, and the words each source reads as. */
import { describe, expect, it } from 'vitest'
import { SOURCE_COLOUR, SOURCE_LABEL_KEY, skillRootTags, sourceLabelKey } from './skillSource.ts'

describe('skillRootTags', () => {
  it('names the preset on a preset root, instead of saying it twice', () => {
    // The defect: this root wore "From a preset" AND "From preset cordis" — two
    // tags for one fact, which reads as two roots.
    expect(skillRootTags({ source: 'preset', root: 'preset:cordis' })).toEqual([
      { key: 'ext.skills.rootFromPreset', params: { owner: 'cordis' }, colour: 'cyan' },
    ])
    // A declaration-model preset is named by its package, and the owner keeps its
    // scope slash intact.
    expect(skillRootTags({ source: 'preset', root: 'preset:@deepseek-ai/dsh-agent-preset' })).toEqual([
      { key: 'ext.skills.rootFromPreset', params: { owner: '@deepseek-ai/dsh-agent-preset' }, colour: 'cyan' },
    ])
  })

  it('gives an ordinary root exactly one source tag', () => {
    expect(skillRootTags({ source: 'user-dsh', root: 'user-dsh' })).toEqual([
      { key: 'ext.skills.source.userDsh', colour: 'blue' },
    ])
    expect(skillRootTags({ source: 'bundled', root: 'bundled' })).toEqual([
      { key: 'ext.skills.source.bundled', colour: 'default' },
    ])
  })

  it('adds the run-time tag when the path is not a path', () => {
    const tags = skillRootTags({ source: 'custom', root: 'runtime:0', runtime: true })
    expect(tags.map(tag => tag.key)).toEqual(['ext.skills.source.custom', 'ext.skills.rootRuntime'])
  })

  it('falls back to the source tag for a preset label it cannot read an owner from', () => {
    // Not reachable from the core today (a preset root is always labelled), but the
    // row must never render an empty tag: with no owner there is nothing to name.
    expect(skillRootTags({ source: 'preset', root: 'preset:' })).toEqual([
      { key: 'ext.skills.source.preset', colour: 'cyan' },
    ])
  })
})

describe('source words', () => {
  it('has a label and a colour for every source the core reports', () => {
    for (const source of ['user-dsh', 'user-agents', 'custom', 'bundled', 'preset'] as const) {
      expect(sourceLabelKey(source)).toBe(SOURCE_LABEL_KEY[source])
      expect(typeof SOURCE_COLOUR[source]).toBe('string')
    }
  })
})
