/**
 * Finding dsh installs: which executable paths exist, which package a path belongs
 * to, and whether an install is app-managed (and so deletable).
 */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { spawn } from 'node:child_process'
import os from 'node:os'
import { logger } from '../shared/logger.ts'

import {
  defaultHome, readVersionFromPath, resolveDshPackage, resolveTargetPath, sourceExecutable,
} from './launch.ts'
import type { DshEntry } from '../../../shared/types.ts'

/** Probe every detected dsh (version from its package.json, best-effort). */
export async function probeDshs(): Promise<DshEntry[]> {
  const paths = await detectExecutables()
  return paths.map(execPath => {
    const resolved = resolveDshPackage(execPath)
    const version = resolved?.version ?? readVersionFromPath(execPath)
    return {
      id: execPath,
      name: version === '' ? basename(execPath) : `dsh@${version}`,
      execPath,
      version,
      home: defaultHome(),
    }
  })
}

/** Candidate dirs where a globally-installed dsh executable commonly lands. */
function globalBinCandidates(): string[] {
  if (process.platform === 'win32') {
    const out: string[] = []
    if (process.env.APPDATA) {
      out.push(join(process.env.APPDATA, 'npm'), join(process.env.APPDATA, 'pnpm'))
    }
    if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, 'pnpm'))
    return out
  }
  const home = os.homedir()
  return [join(home, '.local', 'bin'), join(home, '.bin'), join(home, 'bin'), '/usr/local/bin']
}

/** Ceiling for the `where`/`which dsh` PATH probe. It scans the whole PATH, which
 * is slow on a loaded machine and can hang outright — it must never stall the
 * DSH page's executable scan. */
const PATH_PROBE_TIMEOUT_MS = 3000

/** Resolve candidate `dsh` executable paths: PATH lookup + common global bin
 * slots. Uses the filesystem only (never runs `dsh`), with realpath dedupe so
 * the same install surfaced through multiple symlinks is not listed twice. */
export async function detectExecutables(): Promise<string[]> {
  const found = new Set<string>()
  const push = (p: string): void => {
    try { found.add(realpathSync(p)) } catch { found.add(p) }
  }

  // PATH aliases (`where`/`which dsh`) resolve names not on the candidate dirs.
  const resolved = await new Promise<string[]>((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const child = spawn(cmd, ['dsh'], { shell: process.platform === 'win32' })
    let out = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: string[]): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      logger.debug('dsh PATH probe timed out')
      finish([])
    }, PATH_PROBE_TIMEOUT_MS)
    child.stdout?.on('data', (data: Buffer) => { out += String(data) })
    child.on('error', () => finish([]))
    child.on('close', () => finish(out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)))
  })
  resolved.forEach(push)

  // Common global install slots.
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']
  for (const dir of globalBinCandidates()) {
    for (const name of names) {
      const p = join(dir, name)
      if (existsSync(p)) push(p)
    }
  }

  logger.debug(`dsh executables detected: ${found.size}`)
  return [...found]
}

/** The directory that acts as this dsh's install anchor: the nearest ancestor
 * holding a package.json (resolved from a path or a `node … "path"` command).
 * dsh composes in-box bundles from this anchor first — profile-manager mirrors
 * that so the bundles it shows match what dsh actually loads. */
export function resolveInstallAnchor(execPath: string): string | undefined {
  const start = resolveTargetPath(execPath)
  let cur = start
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, 'package.json'))) return cur
    const parent = dirname(cur)
    if (parent === cur) return undefined
    cur = parent
  }
  return undefined
}

/** Build an entry from a manually supplied path (a dsh bin, or a source checkout). */
export async function entryFromPath(path: string): Promise<DshEntry> {
  if (!existsSync(path)) throw new Error(`path not found: ${path}`)
  const sourceExec = existsSync(path) && statSync(path).isDirectory() ? sourceExecutable(path) : undefined
  const basePath = sourceExec ?? path
  const resolved = resolveDshPackage(path)
  const version = resolved?.version ?? readVersionFromPath(path)
  return {
    id: path,
    name: version === '' ? basename(path) : `dsh@${version}`,
    execPath: basePath,
    version,
    home: defaultHome(),
  }
}

/** The directory holding this dsh's executable (its "install path"), used to
 * reveal the install in the OS file explorer. Resolves command strings
 * (`node … "path"`) to the real path's directory. */
export function installDir(execPath: string): string {
  return resolveTargetPath(execPath)
}

/** True when an executable command/path still resolves to an existing file or
 * directory (parses `node … "path"` command strings). Shared by the health
 * checks and the `run:start` preflight, so a missing executable is caught with
 * a clear message instead of failing mid-launch. */
export function existsExecutable(execPath: string): boolean {
  const target = resolveTargetPath(execPath)
  return target !== '' && existsSync(target)
}

/** True when the entry's executable physically lives under `versionRoot` (the
 * version repo this install landed in) — the structural signal of an
 * app-managed install. Prefers the per-entry recorded repo (`entry.versionDir`)
 * so undelete/cleanup still anchor correctly after the setting changes. */
export function isManagedInstall(entry: DshEntry, versionRoot: string): boolean {
  const root = entry.versionDir !== undefined && entry.versionDir.trim() !== '' ? entry.versionDir : versionRoot
  if (root === '') return false
  const rp = root.endsWith(sep) ? root.slice(0, -1) : root
  const execDir = installDir(entry.execPath)
  return execDir === rp || execDir.startsWith(rp + sep)
}

/** A dsh is deletable from the DSH page when it is an app-managed install:
 * the persisted marker, OR (fallback for entries whose marker was clobbered by
 * an id-colliding re-registration) its install root sits under its version repo.
 * System/globally-installed dsh are never managed and thus never removed. */
export function isDeletableDsh(entry: DshEntry, versionRoot?: string): boolean {
  if (entry.managed === true) return true
  if (versionRoot === undefined) return false
  return isManagedInstall(entry, versionRoot)
}
