/**
 * The step rows an import or mirror streams.
 *
 * Two rules matter. A step for a bundle arrives repeatedly (running → ok/error) and
 * keeps its position, so the list reads as a stable checklist rather than reordering
 * under the user. And the stream can deliver several steps in one tick, which is why
 * the updater is pure and the caller writes through a ref rather than reading state
 * that has not re-rendered.
 */
import { describe, expect, it } from 'vitest'
import { bundleStepRow, upsertRow, type StepRow } from './stepRows.ts'
import type { ImportStep } from '../../../shared/types.ts'

const row = (key: string, status: StepRow['status'] = 'running'): StepRow => ({ key, section: 'bundle', label: key, status })

describe('upsertRow', () => {
  it('appends a key it has not seen', () => {
    expect(upsertRow([], row('a')).map(r => r.key)).toEqual(['a'])
    expect(upsertRow([row('a')], row('b')).map(r => r.key)).toEqual(['a', 'b'])
  })

  it('replaces the row with the same key, keeping its position', () => {
    const next = upsertRow([row('a'), row('b'), row('c')], { ...row('b', 'ok'), meta: 'v1.2.3' })
    expect(next.map(r => r.key)).toEqual(['a', 'b', 'c'])
    expect(next[1].status).toBe('ok')
    expect(next[1].meta).toBe('v1.2.3')
  })

  it('does not mutate the list it was given', () => {
    const before = [row('a')]
    upsertRow(before, row('b'))
    expect(before.map(r => r.key)).toEqual(['a'])
  })

  it('leaves the install step appended after the bundles', () => {
    const next = upsertRow([row('bundle:a'), row('bundle:b')], { key: 'install', section: 'install', label: 'install', status: 'running' })
    expect(next.at(-1)?.key).toBe('install')
  })
})

describe('bundleStepRow', () => {
  const step = (over: Partial<Extract<ImportStep, { kind: 'bundle' }>> = {}): Extract<ImportStep, { kind: 'bundle' }> =>
    ({ kind: 'bundle', name: 'pkg', source: 'npm', state: 'running', ...over }) as Extract<ImportStep, { kind: 'bundle' }>

  it('keys the row by the bundle name and uses the caller label', () => {
    const built = bundleStepRow(step(), 'npm · pkg')
    expect(built).toMatchObject({ key: 'bundle:pkg', section: 'bundle', label: 'npm · pkg', status: 'running' })
  })

  it('carries the resolved version as meta', () => {
    expect(bundleStepRow(step({ version: '1.2.3' }), 'x').meta).toBe('v1.2.3')
  })

  it('omits meta for a missing or blank version, rather than showing a bare "v"', () => {
    expect(bundleStepRow(step(), 'x').meta).toBeUndefined()
    expect(bundleStepRow(step({ version: '' }), 'x').meta).toBeUndefined()
  })

  it('omits detail when the step carries none', () => {
    expect(bundleStepRow(step(), 'x').detail).toBeUndefined()
    expect(bundleStepRow(step({ detail: 'boom' }), 'x').detail).toBe('boom')
  })
})
