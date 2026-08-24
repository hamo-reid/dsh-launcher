/** Path-health checks: does what the app has recorded still exist on disk?
 * Drives the top-level "disk vs. app" sync banner and per-row stale markers.
 * Pure function over `DshEntry[]` + store dir — no Electron, no settings. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { existsExecutable, resolveLaunchEntry } from './dsh.ts'
import { findInstalledDir, listPlugins } from './plugins.ts'
import type { DshEntry, HealthIssue } from '../../shared/types.ts'

/** True when a dsh's bundle-node launch entry can't be resolved — the structural
 * sign of an incomplete install. Never runs the process, just maps the entry. */
function launchEntryBroken(execPath: string): boolean {
  try { resolveLaunchEntry(execPath); return false } catch { return true }
}

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
      continue
    }
    // A "broken" install leaves the bin file present but an unresolvable launch
    // entry (network-shell install missing deps/entry). `resolveLaunchEntry`
    // throws when the bundle-node entry can't be mapped → flag it for repair.
    if (launchEntryBroken(d.execPath)) {
      issues.push({ kind: 'dsh-broken', label: d.name, path: d.execPath, missing: false })
    }
  }

  if (storeDir.trim() === '') {
    issues.push({ kind: 'store-unconfigured', label: 'plugin store', missing: true })
  } else if (!existsSync(storeDir)) {
    issues.push({ kind: 'store-missing', label: storeDir, path: storeDir, missing: true })
  } else {
    // Every archived plugin (unique by name) must resolve to an installed copy;
    // in the versioned layout that is one of its version dirs node_modules.
    const names = new Set(listPlugins(storeDir).map(p => p.name))
    for (const name of names) {
      const installed = findInstalledDir([], storeDir, name)
      if (installed === undefined) {
        issues.push({ kind: 'plugin-missing', label: name, path: join(storeDir, name), missing: true })
      }
    }
  }

  return issues
}