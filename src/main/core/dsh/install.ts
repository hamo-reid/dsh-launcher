/**
 * Getting a dsh onto the machine and keeping it current: the official install from
 * npm, registering it, and the in-place upgrade of a managed install.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import os from 'node:os'
import { logger } from '../shared/logger.ts'
import { resolveLaunchEntry } from './launch.ts'
import { installDir, isDeletableDsh } from './probe.ts'
import { runPnpm } from './pnpm.ts'
import { fetchPackageVersions } from '../store/npm.ts'
import { compareVersionsLoose, majorOfVersion } from '../shared/version.ts'
import { archiveHome } from '../profile/home-data.ts'
import { readDshState, writeDshState } from '../profile/appState.ts'
import type {
  DshEntry, DshInstallResult, DshInstallStep, DshUpdateInfo, DshUpdateResult, DshUpdateTrack,
} from '../../../shared/types.ts'

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
 * any same-id stale entry). Extracted from the IPC handler so the background
 * install session and any direct registry path share one registration step. */
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
  writeDshState([...dshes.filter(d => d.id !== entry.id), entry])
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
