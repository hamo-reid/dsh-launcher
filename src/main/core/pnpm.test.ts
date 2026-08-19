/**
 * Tests for the pnpm content-level success heuristic: pnpm can exit non-zero
 * (e.g. ERR_PNPM_IGNORED_BUILDS) yet still have installed everything, so we key
 * on install-output markers rather than the exit code. Pure string logic.
 */
import { describe, expect, it } from 'vitest'
import { installSucceeded } from './pnpm.ts'

describe('installSucceeded', () => {
  it('is true when output shows added packages', () => {
    expect(installSucceeded('Progress: resolved 582, reused 525, downloaded 0, added 523, done\n+ @deepseek-ai/dsh 0.1.0-rc.7')).toBe(true)
    expect(installSucceeded('added 23 packages')).toBe(true)
  })

  it('is true on the Done-in marker', () => {
    expect(installSucceeded('Done in 10.1s using pnpm v10.33.0')).toBe(true)
  })

  it('is false for a pure error / empty output', () => {
    expect(installSucceeded('ERR_PNPM_OUTDATED_LOCKFILE: Cannot install with frozen-lockfile')).toBe(false)
    expect(installSucceeded('')).toBe(false)
  })
})