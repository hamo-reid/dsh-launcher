/**
 * Turning a dsh executable path into something runnable: the launch command, the
 * bundled-node invocation, and reading a version out of the nearest manifest.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import os from 'node:os'
import { logger } from '../shared/logger.ts'

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

/** The exact node invocation to launch a dsh with the app's BUNDLED Node
 * (`process.execPath` + `ELECTRON_RUN_AS_NODE`) — never a system `node` nor a
 * shell. A source checkout runs through `tsx`; a published install runs its
 * `bin` entry directly; a raw `.js` target runs as-is; anything else throws
 * (callers report it as `dsh-broken` / `run.execLaunchResolve`). The returned
 * script is verified to exist so this doubles as a "can it launch?" probe. */
export interface LaunchEntry {
  script: string
  /** Run the script via node's `--import tsx/esm` loader in the child cwd. */
  tsx: boolean
  /** Child working dir — where the tsx loader / module graph resolves from. */
  cwd: string
}

export function resolveLaunchEntry(execPath: string): LaunchEntry {
  const resolved = resolveDshPackage(execPath)
  if (resolved !== undefined) {
    if (resolved.kind === 'source') {
      const script = join(resolved.root, 'src', 'bin.ts')
      if (!existsSync(script)) throw new Error(`源码签出缺少入口：${script}`)
      return { script, tsx: true, cwd: resolved.root }
    }
    const bin = readPackageBin(resolved.root)
    if (bin === undefined) throw new Error(`dsh 包缺少 bin 入口：${resolved.root}`)
    const script = join(resolved.root, bin)
    if (!existsSync(script)) throw new Error(`dsh 包入口不存在：${script}`)
    return { script, tsx: false, cwd: resolved.root }
  }
  if (isScriptFile(execPath)) return { script: execPath, tsx: false, cwd: dirname(execPath) }
  throw new Error(`无法解析 dsh 启动入口：${execPath}`)
}

/** The `bin` file of a published dsh package (string, or the `dsh` entry of an
 * object), normalized for joining against the package root. */
function readPackageBin(pkgRoot: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
      bin?: string | Record<string, string>
    }
    if (typeof manifest.bin === 'string') return manifest.bin
    if (manifest.bin !== null && typeof manifest.bin === 'object') {
      const value = manifest.bin['dsh'] ?? Object.values(manifest.bin)[0]
      return typeof value === 'string' ? value : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Whether `path` is an existing `.js` / `.cjs` / `.mjs` file (bundle-node-runnable). */
function isScriptFile(path: string): boolean {
  if (!existsSync(path)) return false
  try { return statSync(path).isFile() && /\.(?:js|cjs|mjs)$/i.test(path) } catch { return false }
}

/** Standard home for auto-detected installs. */
export function defaultHome(): string {
  return join(os.homedir(), '.dsh')
}

/** Reduce a target (path, file, or a `node … "path"` command string) to a real path. */
export function resolveTargetPath(target: string): string {
  const quoted = /"([^"]+)"/.exec(target)
  if (quoted !== null) return quoted[1]
  if (existsSync(target)) {
    return statSync(target).isDirectory() ? target : dirname(target)
  }
  return target
}

/** Read the `version` from a manifest ('' if unreadable/absent). */
export function readPkgVersion(manifestPath: string): string {
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
export function sourceExecutable(path: string): string | undefined {
  const bin = join(path, 'apps', 'cli', 'src', 'bin.ts')
  if (!existsSync(bin)) return undefined
  return `node --import tsx/esm "${bin}"`
}
