/**
 * What one library skill's cell means on one dsh, and how to render it.
 *
 * Three views need the same answer (the library card's summary, the install
 * modal's hint, the dsh panel's row tag), and the answer has a trap in it:
 * `problem` is NOT a verdict about being current. An unreadable copy — or an
 * unreadable library entry — cannot be fixed by reinstalling, so presenting it as
 * "the library has updates" is a wrong diagnosis, and that misdiagnosis is exactly
 * what the reason exists to prevent. `problem` therefore outranks the verdict
 * everywhere, and the reason travels with it.
 */
import type { SkillLibInstall } from '../../../shared/types.ts'

/** The cell's state. `problem` wins over every verdict. */
export type InstallCellState = 'notInstalled' | 'upToDate' | 'stale' | 'problem'

/** Resolve one cell's state. */
export function installCellState(
  cell: Pick<SkillLibInstall, 'installed' | 'stale' | 'problem'>,
): InstallCellState {
  if (cell.problem !== undefined) return 'problem'
  if (!cell.installed) return 'notInstalled'
  return cell.stale ? 'stale' : 'upToDate'
}

/** The i18n key suffix for a state's tag (`ext.skills.<key>`). */
export function installCellTagKey(state: InstallCellState): 'problemTag' | 'notInstalled' | 'staleTag' | 'upToDateTag' {
  if (state === 'problem') return 'problemTag'
  if (state === 'notInstalled') return 'notInstalled'
  return state === 'stale' ? 'staleTag' : 'upToDateTag'
}

/** The Tag colour for a state. */
export function installCellColour(state: InstallCellState): string {
  if (state === 'problem') return 'error'
  if (state === 'stale') return 'warning'
  return state === 'upToDate' ? 'success' : 'default'
}

/** The problems across a set of cells, as `<dsh>: <reason>` lines — what a
 * summary tag's tooltip shows. */
export function installProblems(cells: readonly SkillLibInstall[]): string[] {
  return cells
    .filter(cell => cell.problem !== undefined)
    .map(cell => `${cell.dshName}: ${cell.problem ?? ''}`)
}
