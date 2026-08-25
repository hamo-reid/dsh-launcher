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
import { compareVersionsLoose, majorOfVersion } from './version.ts'
import { archiveHome } from './home-data.ts'
import { readDshState, writeDshState } from './appState.ts'
import type { DshEntry, DshInstallResult, DshInstallStep, DshUpdateInfo, DshUpdateResult, DshUpdateTrack } from '../../shared/types.ts'

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
    // 网络差时让 pnpm 重试，避免一次抖动就产生残缺安装。
    const result = await runPnpm(target, [
      'add', `@deepseek-ai/dsh@${resolved}`,
      '--fetch-retries=3', '--fetch-retry-maxtimeout=60000',
    ])
    if (!result.ok) {
      emit({ kind: 'install', state: 'error', detail: result.text })
      throw new Error(`安装官方 dsh 失败：${result.text}`)
    }

    const execPath = pickBinCandidate(target)
    // 装后可用性冒烟（浅）：确认能解析出捆绑 node 可直启的入口。bin/入口
    // 一旦缺失（网络残装），本次安装判失败、给出可读错误，避免留下一个
    // “假装成功”却没法用的残缺 dsh，也便于用户走「重新安装」修复。
    try {
      resolveLaunchEntry(execPath)
    } catch (probeError) {
      const detail = probeError instanceof Error ? probeError.message : String(probeError)
      emit({ kind: 'install', state: 'error', detail })
      throw new Error(`官方 dsh 安装不完整：${detail}`)
    }
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

/** Register a freshly installed official dsh in the app's dsh list (replacing
 * any same-id stale entry) and make it active. Extracted from the IPC handler so
 * the background install session and any direct registry path share one
 * registration step. */
export function registerInstalledDsh(versionDir: string, name: string, info: DshInstallResult): DshEntry {
  const { dshes } = readDshState()
  const entry: DshEntry = {
    id: info.execPath,
    name,
    execPath: info.execPath,
    version: info.version,
    home: info.home,
    // App-managed (in the version repo) — the only kind deletable from the DSH page.
    managed: true,
    // The version-repo root this install actually landed in — cleanup anchors here.
    versionDir,
  }
  writeDshState([...dshes.filter(d => d.id !== entry.id), entry], entry.id)
  return entry
}

// ── update (in-place upgrade of a managed dsh) ───────────────────────────────

/** Available update tracks for `current`: the stable `latest` tag and/or the
 * prerelease `next` tag, each only when it is newer than the install. `null`
 * when nothing is newer (or the dist-tags cannot be resolved). Prerelease
 * comparison (the `next` track) uses semver's own semantics via
 * `compareVersionsLoose`, so `2.0.0-beta.1` reads as newer than `1.9.x` but
 * older than `2.0.0`. */
export async function checkForDshUpdate(current: string): Promise<DshUpdateInfo | null> {
  const cur = current.trim()
  if (cur === '') return null
  const info = await fetchPackageVersions('@deepseek-ai/dsh')
  const stable = (info.distTags.latest ?? info.versions[0] ?? '').trim()
  const track = (version: string | undefined): DshUpdateTrack | undefined => {
    const v = version?.trim()
    if (v === undefined || v === '') return undefined
    if (compareVersionsLoose(v, cur) <= 0) return undefined
    return { version: v, majorBump: majorOfVersion(v) !== majorOfVersion(cur) }
  }
  const latest = track(stable)
  // Only offer `next` when it is a genuinely different version than stable.
  const nextTag = info.distTags.next
  const next = track(nextTag !== undefined && nextTag === stable ? undefined : nextTag)
  if (latest === undefined && next === undefined) return null
  return {
    current: cur,
    ...(latest !== undefined ? { latest } : {}),
    ...(next !== undefined ? { next } : {}),
  }
}

/** The version-repo sub-directory owning `entry`'s executable (its install-dir
 * basename), or `''` when not under `root`. Same structural probe the delete
 * path uses, so update anchors on the real install even after a rename. */
export function installSubName(entry: DshEntry, root: string): string {
  if (root === '' || !existsSync(root)) return ''
  const execDir = installDir(entry.execPath)
  for (const sub of readdirSync(root, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue
    const p = join(root, sub.name)
    let rp = p
    try { rp = realpathSync(p) } catch { /* fall back to literal path */ }
    if (execDir === rp || execDir.startsWith(rp + sep)) return sub.name
  }
  return ''
}

/** Update a managed dsh in place: back up its home, reinstall the named version
 * into the same version-repo slot, and leave the home live. The version choice
 * and any major-bump confirmation are the caller's job (the IPC layer gates
 * those); this only requires the install to be app-managed. Home is archived to
 * `<versionRepo>/../backups/<name>-<ts>/` first as the breaking-change safety
 * net, so even a failed reinstall (which discards the now-cleared target) leaves
 * the user's data recoverable from the reported `backupDir`. */
export async function updateDsh(
  entry: DshEntry,
  versionDir: string,
  opts: { version?: string } = {},
  onProgress?: (step: DshInstallStep) => void,
): Promise<DshUpdateResult> {
  if (!isDeletableDsh(entry, entry.versionDir ?? versionDir)) {
    throw new Error('该 dsh 不是 app 管理的版本实例，无法更新')
  }
  const root = entry.versionDir !== undefined && entry.versionDir.trim() !== '' ? entry.versionDir : versionDir
  const name = installSubName(entry, root)
  if (name === '') throw new Error('无法定位该 dsh 在版本库中的安装目录')

  const backupDir = join(dirname(root), 'backups', `${name}-${Date.now()}`)
  archiveHome(entry.home, backupDir)
  logger.info(`dsh update backup: ${name} → ${backupDir}`)

  // Clear the old install tree, then reinstall the target version in place. The
  // home is deliberately not touched here — it survives a clean update; on a
  // failed one it is recoverable from `backupDir`.
  await rm(join(root, name), { recursive: true, force: true })
  const result = await installOfficialDsh(root, name, opts.version, onProgress)
  return { backupDir, version: result.version }
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