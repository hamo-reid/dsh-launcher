/** The "new preset" dialog's own verdict on a draft, and the id set it must be
 * given: the roster does not show a kept directory, while the core refuses it. */
import { describe, expect, it } from 'vitest'
import { presetCreateBlock, presetCreateReady, presetTakenIds } from './presetCreate.ts'

const draft = (over: Partial<Parameters<typeof presetCreateReady>[0]> = {}) => ({
  toId: 'review',
  takenIds: new Set<string>(),
  source: 'minimal',
  busy: false,
  ...over,
})

describe('presetTakenIds', () => {
  it('counts the kept directories as taken, not just the roster', () => {
    // The bug this closes: the roster is the ONLY thing the page shows, and the
    // core refuses a kept directory's id as well — so the dialog said "free" and
    // the create then came back `preset.exists` for an id never on screen.
    const ids = presetTakenIds([{ id: 'mine' }], [{ id: 'liangshen' }])
    expect([...ids].sort()).toEqual(['liangshen', 'mine'])
  })
})

describe('presetCreateBlock', () => {
  it('passes a free, well-formed id', () => {
    expect(presetCreateBlock(draft())).toBeNull()
  })

  it('reports an id a kept directory holds as taken, not as free', () => {
    // The core refuses this one (the directory's id would collide the moment
    // anyone migrated it) and the roster never shows it — which is exactly why
    // the dialog cannot answer "taken" from the roster alone.
    expect(presetCreateBlock(draft({ toId: 'liangshen', takenIds: new Set(['liangshen']) }))).toBe('taken')
  })

  it('reports a malformed id before asking whether it is taken', () => {
    const ids = new Set(['Bad_ID'])
    expect(presetCreateBlock(draft({ toId: 'Bad_ID', takenIds: ids }))).toBe('badId')
  })

  it('says nothing about an empty draft', () => {
    expect(presetCreateBlock(draft({ toId: '' }))).toBeNull()
  })
})

describe('presetCreateReady', () => {
  it('is ready for a named, free draft', () => {
    expect(presetCreateReady(draft())).toBe(true)
  })

  it('is not ready without a source, without an id, while busy, or when blocked', () => {
    expect(presetCreateReady(draft({ source: '' }))).toBe(false)
    expect(presetCreateReady(draft({ toId: '' }))).toBe(false)
    expect(presetCreateReady(draft({ busy: true }))).toBe(false)
    expect(presetCreateReady(draft({ takenIds: new Set(['review']) }))).toBe(false)
  })
})
