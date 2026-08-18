/** Discover/register dsh installs. Version is read from the target path's
 * package.json (never by running commands); each dsh owns its home.
 *
 * Knowing the deployed shape matters: the published `@deepseek-ai/dsh` package
 * is the repos's `apps/cli`, with `bin: { dsh: "lib/bin.js" }` (source checkout
 * runs `apps/cli/src/bin.ts` via `node --import tsx/esm`). We locate the dsh
 * *package root* (not the `.bin` shim's neighbours) to read the real version. */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { spawn } from 'node:child_process'
import os from 'node:os'
import type { DshEntry } from '../../shared/types.ts'

/** Re-export the shared dsh shape for existing core/ipc callers. */
export type { DshEntry } from '../../shared/types.ts'

/** A runnable-from-anywhere launch command (absolute path). A source checkout
 * maps to `node --import tsx/esm "<repo>/apps/cli/src/bin.ts"`; a real dsh
 * executable (on PATH) stays as-is. */
export function baseLaunch(execPath: string): string {
  const target = resolveTargetPath(execPath)
  const isSourceCheckout = target.includes(`${sep}apps${sep}cli`)
    || target.includes('/apps/cli')
    || existsSync(join(target, 'apps', 'cli', 'src', 'bin.ts'))
  if (isSourceCheckout) return `node --import tsx/esm "${join(target, 'apps', 'cli', 'src', 'bin.ts')}"`
  return execPath
}

/** Standard home for auto-detected installs. */
export function defaultHome(): string {
  return join(os.homedir(), '.dsh')
}

/** Reduce a target (path, file, or a `node … "path"` command string) to a real path. */
function resolveTargetPath(target: string): string {
  const quoted = /"([^"]+)"/.exec(target)
  if (quoted !== null) return quoted[1]
  if (existsSync(target)) {
    return statSync(target).isDirectory() ? target : dirname(target)
  }
  return target
}

/** Read the `version` from a manifest ('' if unreadable/absent). */
function readPkgVersion(manifestPath: string): string {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string }
    return manifest.version ?? ''
  } catch {
    return ''
  }
}

/** Read the version from the nearest package.json walking up from `target`. */
export function readVersionFromPath(target: string): string {
  const start = resolveTargetPath(target)
  let cur = start
  for (let i = 0; i < 5; i++) {
    const manifestPath = join(cur, 'package.json')
    if (existsSync(manifestPath)) return readPkgVersion(manifestPath)
    const parent = dirname(cur)
    if (parent === cur) return ''
    cur = parent
  }
  return ''
}

/** Located dsh package root + how it is deployed. */
export interface DshResolved {
  /** The dsh package directory holding the manifest. */
  root: string
  /** Published npm package (`@deepseek-ai/dsh`) vs a source checkout. */
  kind: 'publish' | 'source'
  version: string
}

/** Locate the dsh package a given executable/path belongs to, walking up from
 * the target (following realpath to bypass `.bin` shims). Returns `undefined`
 * when no `@deepseek-ai/dsh` package or `apps/cli` manifests can be found. */
export function resolveDshPackage(execPath: string): DshResolved | undefined {
  let start = execPath
  try {
    const rp = realpathSync(execPath)
    if (existsSync(rp)) start = rp
  } catch {
    // keep execPath as-is (e.g. a vanilla path that doesn't realpath)
  }
  if (!existsSync(start) && existsSync(dirname(start))) start = dirname(start)
  let cur = start
  for (let i = 0; i < 12; i++) {
    const pub = join(cur, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(pub)) {
      return { root: dirname(pub), kind: 'publish', version: readPkgVersion(pub) }
    }
    const src = join(cur, 'apps', 'cli', 'package.json')
    if (existsSync(src)) {
      return { root: dirname(src), kind: 'source', version: readPkgVersion(src) }
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

/** Resolve an executable command when `path` is actually a dsh source checkout. */
function sourceExecutable(path: string): string | undefined {
  const bin = join(path, 'apps', 'cli', 'src', 'bin.ts')
  if (!existsSync(bin)) return undefined
  return `node --import tsx/esm "${bin}"`
}

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
    child.stdout?.on('data', (data: Buffer) => { out += String(data) })
    child.on('error', () => resolve([]))
    child.on('close', () => resolve(out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)))
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