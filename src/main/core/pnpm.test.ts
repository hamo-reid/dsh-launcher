/**
 * Tests for the pnpm content-level success heuristic: pnpm can exit non-zero
 * (e.g. ERR_PNPM_IGNORED_BUILDS) yet still have installed everything, so we key
 * on install-output markers rather than the exit code. Pure string logic.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSucceeded, runPnpm } from './pnpm.ts'

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

  it('is false when resolution failed with added 0 (progress line, not install)', () => {
    // A dependency-resolve failure can exit non-zero yet leave `added 0` in the
    // progress lines — that must not be mistaken for a successful install.
    expect(installSucceeded('Progress: resolved 98, reused 98, downloaded 0, added 0')).toBe(false)
    expect(installSucceeded('added 0 packages in 1s')).toBe(false)
  })
})

describe('runPnpm', () => {
  it('resolves ok=true with version text for a clean invocation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-pnpm-'))
    try {
      const { ok, text } = await runPnpm(dir, ['--version'])
      expect(ok).toBe(true)
      expect(text.trim()).toMatch(/^\d+\.\d+\.\d+/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves aborted when the caller\'s signal is already aborted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-abort-'))
    try {
      const controller = new AbortController()
      controller.abort()
      const res = await runPnpm(dir, ['--version'], controller.signal)
      expect(res.ok).toBe(false)
      expect(res.aborted).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})