/**
 * Node runtime detection + selection for launching dsh. Detects the app's
 * bundled Node version and any system `node` on PATH; given the user's
 * preference, decides which one dsh runs with.
 *
 * dsh needs Node 22.6+ APIs (`node:zlib` zstd, `node:module`
 * stripTypeScriptTypes). `'system'` preference uses a usable system node and
 * only falls back to the bundled Node 24 when none is available/old enough —
 * the bundled (Electron 40) Node always works, keeping it self-contained.
 */
import { spawnSync } from 'node:child_process'
import { child } from './logger.ts'
import type { NodeEnvironment } from '../../shared/types.ts'

/** Domain-tagged logger for node detection / selection. */
const nodeLog = child('node')

interface Detection {
  bundled: string
  system: { installed: boolean; version: string }
}

let detected: Detection | null = null

/** Whether a system node version satisfies what dsh needs (>= 22.6). */
function usable(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version)
  if (m === null) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > 22 || (major === 22 && minor >= 6)
}

/** Probe the system PATH for a `node`. Cheap (one `node --version`), cached. */
function detect(): Detection {
  if (detected !== null) return detected
  const bundle = process.versions.node
  let system: { installed: boolean; version: string } = { installed: false, version: '' }
  try {
    const probe = spawnSync('node', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
    const version = (probe.stdout ?? '').trim()
    if (probe.status === 0 && /^v?\d+\.\d+\.\d+/.test(version)) {
      system = { installed: true, version }
    }
  } catch { /* no system node on PATH */ }
  detected = { bundled: bundle, system }
  nodeLog.info('node environment detected', { bundled: bundle, system })
  return detected
}

/** Resolve the effective node environment for the user's preference. */
export function nodeEnvironment(preference: 'system' | 'bundled'): NodeEnvironment {
  const { bundled, system } = detect()
  const many = preference !== 'bundled' && system.installed && usable(system.version)
  return { bundled, system, preference, prefer: many ? 'system' : 'bundled' }
}