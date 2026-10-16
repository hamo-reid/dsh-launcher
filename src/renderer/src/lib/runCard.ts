/**
 * What one card in the run page's process rail says, and which actions it
 * offers.
 *
 * The rail is 280px wide and holds several runs side by side with the console,
 * so every card has to answer three questions in as little horizontal space as
 * possible: is it alive, what is it, and what can I do to it. That is why the
 * mode is NOT a tag in the title row (it stole the width a profile name needs)
 * but one part of a single meta line, and why the actions are icon buttons.
 *
 * The decision "a crashed run and a cleanly exited one are different" lives
 * here rather than in the view: both used to render the same grey dot, which is
 * the one distinction a process rail exists to show.
 */
import type { RunInfo } from '../../../shared/types.ts'

/** How a run reads at a glance. */
export type RunDotKind = 'running' | 'failed' | 'ended'

/** A run's dot: live, ended abnormally (non-zero code or a signal), or ended. */
export function runDotKind(run: RunInfo): RunDotKind {
  if (run.status === 'running') return 'running'
  const failed = (run.code ?? 0) !== 0 || (run.signal ?? null) !== null
  return failed ? 'failed' : 'ended'
}

/** What a card's action buttons are, in reading order. A live run can only be
 * stopped; an ended one can be relaunched or dropped from this session's list. */
export type RunCardAction = 'stop' | 'restart' | 'clear'

export function runCardActions(run: RunInfo): readonly RunCardAction[] {
  return run.status === 'running' ? ['stop'] : ['restart', 'clear']
}

/** The single meta line under a run's name: `state · mode · dsh`.
 *
 * The STATE leads because it is the part that has to survive truncation: an
 * ended card also carries two action buttons, and "已退出 · code 1" is the one
 * thing a user opens that row for. An empty part is dropped rather than left as
 * a dangling separator — a run whose dsh was unregistered reports no name. */
export function runCardMeta(run: RunInfo, state: string, mode: string): string {
  return [state, mode, run.dshName].filter(part => part !== '').join(' · ')
}
