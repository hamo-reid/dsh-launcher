/** Discover/register dsh installs. Version is read from the target path's
 * package.json (never by running commands); each dsh owns its home.
 *
 * Knowing the deployed shape matters: the published `@deepseek-ai/dsh` package
 * is the repos's `apps/cli`, with `bin: { dsh: "lib/bin.js" }` (source checkout
 * runs `apps/cli/src/bin.ts` via `node --import tsx/esm`). We locate the dsh
 * *package root* (not the `.bin` shim's neighbours) to read the real version. */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { spawn } from 'node:child_process'
import os from 'node:os'
import { logger } from './logger.ts'
import { runPnpm } from './pnpm.ts'
import { fetchPackageVersions } from './npm.ts'
import type { DshEntry, DshInstallResult, DshInstallStep } from '../../shared/types.ts'

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

// ── official install ─────────────────────────────────────────────────────────

/** Resolve the npm spec + pinned version for an official install. A specified
 * version is used verbatim; an empty version resolves `latest`. Pure (no I/O),
 * so the spec/version assembly is unit-testable. Returns `undefined` when no
 * version could be pinned (both inputs empty/blank). */
export function resolveInstallSpec(
  version: string | undefined,
  latest: string | undefined,
): { spec: string; resolvedVersion: string } | undefined {
  const trimmed = version?.trim()
  if (trimmed !== undefined && trimmed !== '') {
    return { spec: `@deepseek-ai/dsh@${trimmed}`, resolvedVersion: trimmed }
  }
  const latestTrimmed = latest?.trim()
  if (latestTrimmed !== undefined && latestTrimmed !== '') {
    return { spec: `@deepseek-ai/dsh@${latestTrimmed}`, resolvedVersion: latestTrimmed }
  }
  return undefined
}

/** Whether a version name already owns a non-empty target dir — the conflict
 * guard against overwriting an existing install. */
export function versionExists(targetDir: string): boolean {
  return existsSync(targetDir) && readdirSync(targetDir).length > 0
}

/** Read the installed version from a package manifest, falling back to
 * `unknown` when the file is missing or malformed. */
export function readInstalledVersion(manifestPath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** The first existing bin candidate for an installed dsh (`.bin/dsh.cmd` on
 * win, then the POSIX shim, then the in-package bin). */
export function pickBinCandidate(target: string): string {
  const candidates = [
    join(target, 'node_modules', '.bin', 'dsh.cmd'),
    join(target, 'node_modules', '.bin', 'dsh'),
    join(target, 'node_modules', 'dsh', 'bin', 'dsh'),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? join(target, 'node_modules', '.bin', 'dsh')
}

/** Install the official `@deepseek-ai/dsh` into `<versionDir>/<name>` with its
 * own home under `<versionDir>/../homes/<name>`. `version` may be a published
 * npm version or empty — empty pins `latest` via the registry (so the install
 * always runs `pnpm add @deepseek-ai/dsh@<pinned>` and never a bare, slow,
 * end-rendered package spec). `onProgress` streams `DshInstallStep`s, mirroring
 * `importProfile`'s progress callback. On failure the target + home dirs are
 * best-effort cleaned up so a retry never trips a stale non-empty target. */
export async function installOfficialDsh(
  versionDir: string,
  name: string,
  version?: string,
  onProgress?: (step: DshInstallStep) => void,
): Promise<DshInstallResult> {
  const emit: (step: DshInstallStep) => void = onProgress ?? (() => {})
  const target = join(versionDir, name)
  const home = join(dirname(versionDir), 'homes', name)

  // Resolve the version (explicit, or latest) before touching any state.
  emit({ kind: 'version', state: 'running' })
  let resolved: string
  if (version !== undefined && version.trim() !== '') {
    resolved = version.trim()
    emit({ kind: 'version', state: 'ok', version: resolved })
  } else {
    let latest: string | undefined
    try {
      const info = await fetchPackageVersions('@deepseek-ai/dsh')
      latest = info.distTags.latest ?? info.versions[0]
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      emit({ kind: 'version', state: 'error', detail: text })
      throw new Error(`解析 @deepseek-ai/dsh 最新版本失败：${text}`)
    }
    const spec = resolveInstallSpec(undefined, latest)
    if (spec === undefined) {
      emit({ kind: 'version', state: 'error', detail: '未能从 npm 解析 @deepseek-ai/dsh 的最新版本' })
      throw new Error('未能从 npm 解析 @deepseek-ai/dsh 的最新版本')
    }
    resolved = spec.resolvedVersion
    emit({ kind: 'version', state: 'ok', version: resolved })
  }

  let created = false
  try {
    mkdirSync(target, { recursive: true })
    created = true

    emit({ kind: 'install', state: 'running' })
    const result = await runPnpm(target, ['add', `@deepseek-ai/dsh@${resolved}`])
    if (!result.ok) {
      emit({ kind: 'install', state: 'error', detail: result.text })
      throw new Error(`安装官方 dsh 失败：${result.text}`)
    }

    const execPath = pickBinCandidate(target)
    const installedVersion = readInstalledVersion(join(target, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    emit({ kind: 'install', state: 'ok', version: installedVersion })
    return { name, version: installedVersion, execPath, home, dir: target }
  } catch (error) {
    // Only clean leftovers when the dsh package genuinely did NOT get installed:
    // if it did, the install is usable and the failure is downstream (e.g. the
    // icp registration) — deleting a working install would be destructive. home
    // is never created here, so its rm force is a no-op.
    const installed = existsSync(join(target, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    if (!installed && created) await rm(target, { recursive: true, force: true }).catch(() => {})
    await rm(home, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

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