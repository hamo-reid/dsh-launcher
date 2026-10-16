/**
 * The three answers one process-rail card gives: how its status dot reads, which
 * actions it offers, and the single meta line under its name. Pure on purpose —
 * the rail itself is only reachable through IPC and effects, which a
 * server-rendered view test does not run.
 */
import { describe, expect, it } from 'vitest'
import { runCardActions, runCardMeta, runDotKind } from './runCard.ts'
import type { RunInfo } from '../../../shared/types.ts'

const run = (over: Partial<RunInfo> = {}): RunInfo => ({
  id: 'base#1',
  dshId: 'a',
  dshName: 'my-dsh',
  profile: 'base',
  mode: 'app',
  startedAt: 1_000,
  command: 'dsh',
  status: 'running',
  ...over,
})

describe('runDotKind', () => {
  it('reads a live run as running', () => {
    expect(runDotKind(run())).toBe('running')
  })

  it('reads a clean exit as ended', () => {
    expect(runDotKind(run({ status: 'exited', code: 0, signal: null }))).toBe('ended')
  })

  it('reads a non-zero exit as failed', () => {
    expect(runDotKind(run({ status: 'exited', code: 1, signal: null }))).toBe('failed')
  })

  it('reads a signalled exit as failed even without a code', () => {
    // A killed process reports a signal and no code — the case a bare
    // `code !== 0` check would miss and render as a clean end.
    expect(runDotKind(run({ status: 'exited', code: null, signal: 'SIGTERM' }))).toBe('failed')
  })
})

describe('runCardActions', () => {
  it('offers only stop while a run is live', () => {
    expect(runCardActions(run())).toEqual(['stop'])
  })

  it('offers restart and clear once it ended', () => {
    expect(runCardActions(run({ status: 'exited', code: 1 }))).toEqual(['restart', 'clear'])
  })
})

describe('runCardMeta', () => {
  it('leads with the state, then mode and dsh', () => {
    expect(runCardMeta(run(), '12s', 'App console')).toBe('12s · App console · my-dsh')
  })

  it('drops an absent dsh name instead of leaving a dangling separator', () => {
    expect(runCardMeta(run({ dshName: '' }), 'Exited · code 1', 'App console'))
      .toBe('Exited · code 1 · App console')
  })
})
