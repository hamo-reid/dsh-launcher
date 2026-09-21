/**
 * The local version repository: installs that exist on disk under the version dir
 * but are not registered yet.
 *
 * Pure — takes the known entries and the version dir, and never touches settings
 * (the caller persists).
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import os from 'node:os'
import { logger } from '../shared/logger.ts'
import { readPkgVersion } from './launch.ts'
import type { DshEntry } from '../../../shared/types.ts'

/** Scan the version repo for dsh installs that exist on disk but are not yet
 * registered, so they surface in the DSH list instead of lurking invisibly
 * (and blocking an official install of the same name via the versionExists
 * guard). Idempotent: an install already in `dshes` is skipped. Pure — takes
 * `dshes` + `versionDir`, never touches settings (the caller persists). */
export function discoverVersionRepo(dshes: DshEntry[], versionDir: string): DshEntry[] {
  if (versionDir === '' || !existsSync(versionDir)) return []
  const known = new Set(dshes.map(d => d.id))
  const found: DshEntry[] = []
  for (const sub of readdirSync(versionDir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue
    const d = join(versionDir, sub.name)
    const manifest = join(d, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (!existsSync(manifest)) continue // only real dsh installs, skip unrelated dirs

    const bin = join(d, 'node_modules', '.bin')
    const execPath = existsSync(join(bin, 'dsh.cmd'))
      ? join(bin, 'dsh.cmd')
      : existsSync(join(bin, 'dsh')) ? join(bin, 'dsh') : join(bin, 'dsh.cmd')
    if (known.has(execPath)) continue
    known.add(execPath)

    found.push({
      id: execPath,
      name: sub.name,
      execPath,
      version: readPkgVersion(manifest),
      // Same home convention as official installs: <versionRepo>/../homes/<name>.
      home: join(dirname(versionDir), 'homes', sub.name),
      managed: true,
      versionDir,
    })
  }
  return found
}
