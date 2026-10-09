/** The one answer to "what does this library cell mean on this dsh". */
import { describe, it, expect } from 'vitest'
import { installCellColour, installCellState, installCellTagKey, installProblems } from './skillInstallState.ts'
import type { SkillLibInstall } from '../../../shared/types.ts'

const cell = (over: Partial<SkillLibInstall> = {}): SkillLibInstall => ({
  dshId: 'a', dshName: 'dsh@a', installed: false, stale: false, ...over,
})

describe('installCellState', () => {
  it('reads the plain verdicts', () => {
    expect(installCellState(cell())).toBe('notInstalled')
    expect(installCellState(cell({ installed: true }))).toBe('upToDate')
    expect(installCellState(cell({ installed: true, stale: true }))).toBe('stale')
  })

  it('lets a problem outrank every verdict', () => {
    // The trap: a copy that cannot be read must never render as "the library has
    // updates" — reinstalling cannot fix it, and that wrong diagnosis is what the
    // reason is there to prevent. It also covers the unreadable-library-entry case,
    // whose cell is `installed: false` yet is not "not installed" either.
    expect(installCellState(cell({ problem: 'boom' }))).toBe('problem')
    expect(installCellState(cell({ installed: true, stale: true, problem: 'boom' }))).toBe('problem')
    expect(installCellState(cell({ installed: true, problem: 'boom' }))).toBe('problem')
  })

  it('maps every state to a distinct tag and colour', () => {
    expect(installCellTagKey('problem')).toBe('problemTag')
    expect(installCellTagKey('notInstalled')).toBe('notInstalled')
    expect(installCellTagKey('stale')).toBe('staleTag')
    expect(installCellTagKey('upToDate')).toBe('upToDateTag')
    expect(installCellColour('problem')).toBe('error')
    expect(installCellColour('stale')).toBe('warning')
    expect(installCellColour('upToDate')).toBe('success')
    expect(installCellColour('notInstalled')).toBe('default')
  })
})

describe('installProblems', () => {
  it('names the dsh with each reason, and nothing when all cells are fine', () => {
    expect(installProblems([cell(), cell({ installed: true })])).toEqual([])
    expect(installProblems([
      cell({ dshName: 'dsh@a', problem: 'the installed copy cannot be read: /x' }),
      cell({ dshId: 'b', dshName: 'dsh@b', installed: true, stale: true }),
      cell({ dshId: 'c', dshName: 'dsh@c', problem: 'the library entry cannot be read: /y' }),
    ])).toEqual([
      'dsh@a: the installed copy cannot be read: /x',
      'dsh@c: the library entry cannot be read: /y',
    ])
  })
})
