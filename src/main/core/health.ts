/** Path-health checks: does what the app has recorded still exist on disk?
 * Drives the top-level "disk vs. app" sync banner and per-row stale markers.
 * Pure function over `DshEntry[]` + store dir — no Electron, no settings. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { existsExecutable } from './dsh.ts'
import { listPlugins } from './plugins.ts'
import type { DshEntry, HealthIssue } from '../../shared/types.ts'

/** Flag every registered dsh (missing executable, missing home) and every store
 * plugin whose node_modules dir is gone, plus an unconfigured/missing store.
 * Stays shallow: only stats each recorded path, never walks a tree. */
export function checkHealth(dshes: DshEntry[], storeDir: string): HealthIssue[] {
  const issues: HealthIssue[] = []

  for (const d of dshes) {
    // Only a missing *executable* is a real disk↔app mismatch. A missing home is
    // normal for a freshly installed dsh (created on first run) and harmless —
    // every writer lazily mkdirs it, and run:start anchors cwd on the package.
    if (!existsExecutable(d.execPath)) {
      issues.push({ kind: 'dsh-exec', label: d.name, path: d.execPath, missing: true })
    }
  }

  if (storeDir.trim() === '') {
    issues.push({ kind: 'store-unconfigured', label: 'plugin store', missing: true })
  } else if (!existsSync(storeDir)) {
    issues.push({ kind: 'store-missing', label: storeDir, path: storeDir, missing: true })
  } else {
    for (const p of listPlugins(storeDir)) {
      const pluginDir = join(storeDir, 'node_modules', p.name)
      if (!existsSync(join(pluginDir, 'package.json'))) {
        issues.push({ kind: 'plugin-missing', label: p.name, path: pluginDir, missing: true })
      }
    }
  }

  return issues
}