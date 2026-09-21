/**
 * Kill a child process and, on Windows, its whole tree.
 *
 * `/T` is not optional on Windows: under `shell: true` the direct child is
 * `cmd.exe` and the real work is its grandchild (`npx` → `node`), so killing only
 * the child leaves an orphan holding the port. Elsewhere SIGTERM reaches the
 * process itself, which is all any of these callers needs.
 *
 * Best-effort by design: every caller is reacting to a stop, an abort or an
 * already-exiting process, and none of them can do anything about a kill that
 * lost its race. A failure here must never surface as a failed launch or probe.
 */
import { spawn, type ChildProcess } from 'node:child_process'

export function killProcessTree(target: ChildProcess | number): void {
  const pid = typeof target === 'number' ? target : target.pid
  // No pid means the process never started (a failed spawn), so there is nothing
  // to kill — and `child.kill()` below would be a no-op anyway.
  if (pid === undefined) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'])
    else process.kill(pid, 'SIGTERM')
  } catch {
    // Already gone — the common case for a stop racing a natural exit.
  }
}
