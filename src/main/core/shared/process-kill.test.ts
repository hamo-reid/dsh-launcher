/**
 * The best-effort contract of the shared process-tree kill.
 *
 * Every caller is reacting to a stop or an abort, and several of them race a
 * process that has already exited — `ipc/run.ts` kills a child the user just
 * stopped, `core/dsh/pnpm.ts` kills one whose abort arrived as pnpm finished. A throw
 * from here would surface as a failed launch or a failed install, so "never
 * throws" is the property worth locking.
 */
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { killProcessTree } from './process-kill.ts'

/** A process that exits immediately — gone by the time it is killed. */
async function exitedChild(): Promise<ReturnType<typeof spawn>> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return child
}

describe('killProcessTree', () => {
  it('does nothing, and does not throw, without a pid', () => {
    // A failed spawn leaves `pid` undefined and no handle to kill.
    expect(() => killProcessTree({ pid: undefined } as never)).not.toThrow()
  })

  it('does not throw for a process that has already exited', async () => {
    const child = await exitedChild()
    expect(() => killProcessTree(child)).not.toThrow()
    expect(() => killProcessTree(child.pid ?? 0)).not.toThrow()
  })

  it('does not throw for a pid that never existed', () => {
    // Above the practical pid ceiling on both platforms, so the kill fails.
    expect(() => killProcessTree(0x7ffffff0)).not.toThrow()
  })
})
