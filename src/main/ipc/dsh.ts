/** IPC for dsh installs (`dsh:*`): registry, activation, home/profile-dir, and
 * official installation. */

import { shell } from 'electron'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import {
  baseLaunch, checkForDshUpdate, defaultHome, discoverVersionRepo, entryFromPath, existsExecutable,
  installDir, installOfficialDsh, isDeletableDsh, probeDshs, readVersionFromPath, resolveDshPackage,
  updateDsh, versionExists, type DshEntry,
} from '../core/dsh.ts'
import {
  dshVersionDir, effectiveProfileDir, readDshState, writeDshState,
} from '../core/appState.ts'
import { loadSettings, saveSettings } from '../core/settings.ts'
import { fetchPackageVersions } from '../core/npm.ts'
import { majorOfVersion } from '../core/version.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { logger } from '../core/logger.ts'
import { handle } from './handle.ts'
import type { DshInstallResult, DshUpdateInfo, DshUpdateResult, IpcResult, PackageVersionInfo } from '../../shared/types.ts'

/** A filesystem-safe version name (defaults to `official`). */
function safeVersionName(name: string | undefined): string {
  const cleaned = (name ?? '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-').trim()
  return cleaned === '' ? 'official' : cleaned
}

/** Physically delete a dsh install. App-managed version instances (under the
 * dsh version repo) are removed wholesale together with their dedicated home;
 * otherwise the directory owning the executable is removed.
 *
 * Async deletion via `fs/promises.rm` so the huge node_modules tree does not
 * block the main process's event loop (which would make the whole app hang). */
async function deleteDshFiles(entry: DshEntry): Promise<void> {
  const execDir = installDir(entry.execPath)
  // Anchor on the repo this install actually landed in (set at install time),
  // so cleanup still works after the current dshVersionDir setting changed.
  const versionRoot = entry.versionDir ?? dshVersionDir()
  const targets: string[] = []
  const instanceNames: string[] = []
  if (existsSync(versionRoot)) {
    for (const sub of readdirSync(versionRoot, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue
      const p = join(versionRoot, sub.name)
      let rp = p
      try { rp = realpathSync(p) } catch { /* fall back to literal path */ }
      if (execDir === rp || execDir.startsWith(rp + sep)) {
        targets.push(p)
        instanceNames.push(sub.name)
      }
    }
  }
  if (targets.length === 0) targets.push(execDir)
  for (const t of targets) {
    await rm(t, { recursive: true, force: true })
  }
  // Clean up the dedicated home (`<versionRepo>/../homes/<name>`).
  const homes = join(dirname(versionRoot), 'homes')
  for (const name of instanceNames) {
    const h = join(homes, name)
    await rm(h, { recursive: true, force: true })
  }
}

/** Persist the dsh version-repository dir (shared by `dsh:setVersionDir` and
 * the onboarding wizard). Empty string resets to the default. */
export function setVersionDirValue(dir: string): IpcResult<boolean> {
  try {
    saveSettings({ ...loadSettings(), dshVersionDir: dir.trim() === '' ? undefined : dir.trim() })
    return { ok: true, value: true }
  } catch (error) {
    return failFromError(error)
  }
}

export function registerDshIpc(): void {
  handle('dsh:list', (): IpcResult<{ dshes: DshEntry[]; activeDshId?: string }> => {
    const { dshes, activeDshId } = readDshState()
    // Surface dsh versions already on disk in the version repo but not yet
    // registered: auto-register them so they appear in the DSH list (and stop
    // invisibly blocking an official install of the same name). Idempotent.
    const discovered = discoverVersionRepo(dshes, dshVersionDir())
    if (discovered.length > 0) {
      writeDshState([...dshes, ...discovered], activeDshId)
      logger.info(`discovered ${discovered.length} repo version(s): ${discovered.map(x => x.name).join(',')}`)
    }
    const merged = [...dshes, ...discovered]
    return {
      ok: true,
      value: {
        dshes: merged.map(d => {
          // 精确定位 dsh 包根：版本读 `@deepseek-ai/dsh`（或 apps/cli）的 package.json，
          // 所在位置指向包根而非 `.bin` shim 目录。shim 上旧式暴力上溯会读错版本。
          const resolved = resolveDshPackage(d.execPath)
          return {
            ...d,
            version: resolved?.version ?? d.version ?? readVersionFromPath(d.execPath),
            // 派生 managed：persisted 标记 或 该安装根位于其版本库内（修复标记被覆盖的旧条目）。
            managed: isDeletableDsh(d, d.versionDir ?? dshVersionDir()),
            launch: baseLaunch(d.execPath),
            profileDir: effectiveProfileDir(d),
            dir: resolved?.root ?? installDir(d.execPath),
          }
        }),
        activeDshId,
      },
    }
  })

  // Whether a managed dsh has a newer release available. `value: null` = up to date.
  handle('dsh:checkUpdate', async (_event, id: string): Promise<IpcResult<DshUpdateInfo | null>> => {
    const entry = readDshState().dshes.find(d => d.id === id)
    if (entry === undefined) return fail(E.dshNotFound)
    return { ok: true, value: await checkForDshUpdate(entry.version) }
  })

  // In-place update of a managed dsh: backup home → reinstall target version →
  // refresh the entry version. Cross-major requires `ackMajorRisk` to proceed.
  handle('dsh:update', async (event, id: string, opts?: { version?: string; ackMajorRisk?: boolean }): Promise<IpcResult<DshUpdateResult>> => {
    const { dshes, activeDshId } = readDshState()
    const entry = dshes.find(d => d.id === id)
    if (entry === undefined) return fail(E.dshNotFound)
    if (!isDeletableDsh(entry, entry.versionDir ?? dshVersionDir())) return fail(E.dshNotManaged)
    // Resolve the target version: explicit, else the latest stable release.
    let target = opts?.version?.trim()
    if (target === undefined || target === '') {
      target = (await checkForDshUpdate(entry.version))?.latest?.version
    }
    if (target === undefined || target === '') return fail(E.dshUpToDate)
    // Cross-major → require explicit acknowledgement of the breaking-change risk.
    const majorBump = majorOfVersion(target) !== majorOfVersion(entry.version)
    if (majorBump && opts?.ackMajorRisk !== true) {
      return fail(E.dshMajorRisk, { current: entry.version, latest: target })
    }
    const result = await updateDsh(entry, dshVersionDir(), { version: target },
      step => event.sender.send('install:event', step))
    writeDshState(dshes.map(d => d.id === id ? { ...d, version: result.version } : d), activeDshId)
    logger.info(`dsh updated: ${entry.name} ${entry.version} → ${result.version} (backup ${result.backupDir})`)
    return { ok: true, value: result }
  })

  // Reveal a dsh's install directory in the OS file explorer.
  handle('dsh:revealDir', async (_event, id: string): Promise<IpcResult<boolean>> => {
    const { dshes } = readDshState()
    const entry = dshes.find(d => d.id === id)
    if (entry === undefined) return fail(E.dshNotFound)
    const error = await shell.openPath(installDir(entry.execPath))
    return error === '' ? { ok: true, value: true } : fail(E.shellOpenPath, { detail: error })
  })

  handle('dsh:add', async (_event, path: string): Promise<IpcResult<DshEntry>> => {
    let entry: DshEntry
    try {
      entry = await entryFromPath(path)
    } catch {
      // Not a real filesystem path — e.g. a command string like
      // `node --import tsx/esm "…"`. Register it as-is (version unknown).
      entry = { id: path, name: 'dsh (manual)', execPath: path, version: '', home: defaultHome() }
    }
    const { dshes } = readDshState()
    // 保留被替换条目的 app-managed 标记：官方安装后若在「Add DSH」里用同一条 execPath
    // 重新登记，不能把 managed:true 覆盖成未托管——否则该 dsh 会被当系统 dsh 保护而无法删除。
    const existing = dshes.find(x => x.id === entry.id)
    writeDshState([...dshes.filter(d => d.id !== entry.id), existing?.managed === true ? { ...entry, managed: true } : entry])
    return { ok: true, value: entry }
  })

  handle('dsh:remove', async (_event, id: string, opts?: { deleteFiles?: boolean }): Promise<IpcResult<boolean>> => {
    const { dshes, activeDshId } = readDshState()
    const entry = dshes.find(d => d.id === id)
    // 非 app 管理的（系统级/手动加入的用户已有安装）一律禁止删除，避免误删用户全局
    // 环境或绕过 UI 的 `dsh:remove` 调用。唯一例外：该可执行已不存在（磁盘与 app 不同步）
    // —— 此刻允许脱管（仍不删文件），让用户能清理失效条目。
    const stale = entry !== undefined && !existsExecutable(entry.execPath)
    if (entry !== undefined && !stale && !isDeletableDsh(entry, entry.versionDir ?? dshVersionDir())) {
      return fail(E.dshProtected)
    }
    logger.info(`dsh removed: ${entry?.name ?? id}${opts?.deleteFiles === true ? ' (delete files)' : ''}`)
    // 先从列表移除（脱管 — 始终执行）。
    writeDshState(dshes.filter(d => d.id !== id), activeDshId === id ? undefined : activeDshId)
    // 可选的物理删除：app 管理的版本实例（含其独立 home），其它则删可执行所属目录。
    // await 异步删除，避免同步 rm 阻塞主进程导致 App 未响应。
    if (opts?.deleteFiles === true && entry !== undefined) {
      await deleteDshFiles(entry)
    }
    return { ok: true, value: true }
  })

  handle('dsh:setActive', (_event, id: string): IpcResult<boolean> => {
    const { dshes } = readDshState()
    const d = dshes.find(candidate => candidate.id === id)
    if (d === undefined) return fail(E.dshNotFound)
    writeDshState(dshes, id)
    logger.info(`dsh activated: ${d.name}`)
    return { ok: true, value: true }
  })

  handle('dsh:setHome', (_event, id: string, home: string): IpcResult<boolean> => {
    const { dshes, activeDshId } = readDshState()
    const next = dshes.map(d => d.id === id ? { ...d, home } : d)
    writeDshState(next, activeDshId)
    return { ok: true, value: true }
  })

  handle('dsh:setProfileDir', (_event, id: string, dir: string): IpcResult<boolean> => {
    const { dshes, activeDshId } = readDshState()
    if (!dshes.some(d => d.id === id)) return fail(E.dshNotFound)
    const trimmed = dir.trim()
    let profilesDir: string | undefined
    if (trimmed !== '') {
      const target = resolve(trimmed)
      if (existsSync(target) && !statSync(target).isDirectory()) {
        return fail(E.storeNotDir, { path: target })
      }
      profilesDir = target
    }
    // An empty value clears the override: profile dir follows <home>/profiles again.
    const next = dshes.map(d => d.id === id ? { ...d, profilesDir } : d)
    writeDshState(next, activeDshId)
    return { ok: true, value: true }
  })

  handle('dsh:rename', (_event, id: string, name: string): IpcResult<boolean> => {
    const trimmed = name.trim()
    if (trimmed === '') return fail(E.nameInvalid)
    const { dshes, activeDshId } = readDshState()
    if (!dshes.some(d => d.id === id)) return fail(E.dshNotFound)
    writeDshState(dshes.map(d => d.id === id ? { ...d, name: trimmed } : d), activeDshId)
    return { ok: true, value: true }
  })

  handle('dsh:addManual', (_event, alias: string, execPath: string): IpcResult<DshEntry> => {
    // Register without probing/running commands: user-supplied alias, version unknown.
    const baseName = alias.trim() !== '' ? alias.trim() : (execPath.split(/[\\/]/).pop() ?? execPath)
    const entry: DshEntry = {
      id: execPath,
      name: baseName,
      execPath,
      version: readVersionFromPath(execPath),
      home: defaultHome(),
    }
    const { dshes } = readDshState()
    // 保留被替换条目的 app-managed 标记：官方安装后若在「Add DSH」里用同一条 execPath
    // 重新登记，不能把 managed:true 覆盖成未托管——否则该 dsh 会被当系统 dsh 保护而无法删除。
    const existing = dshes.find(x => x.id === entry.id)
    writeDshState([...dshes.filter(d => d.id !== entry.id), existing?.managed === true ? { ...entry, managed: true } : entry])
    return { ok: true, value: entry }
  })

  handle('dsh:probe', async (_event, path?: string): Promise<IpcResult<DshEntry[]>> => {
    // No path → probe the system; a path → probe that single candidate.
    if (path === undefined || path === '') return { ok: true, value: await probeDshs() }
    return { ok: true, value: [await entryFromPath(path)] }
  })

  handle('dsh:installOfficial', async (event, options?: { versionDir?: string; name?: string; version?: string; force?: boolean }): Promise<IpcResult<DshInstallResult>> => {
      const currentRoot = dshVersionDir()
      const requested = options?.versionDir?.trim()
      const versionDir = requested !== undefined && requested !== '' ? requested : currentRoot
      // 用户在安装对话框把版本库指向了非当前设置的目录：写回设置，让「官方安装到指定目录」
      // 持久可锚定（删除/清理用 entry.versionDir 而不是之后可能变化的 dshVersionDir()）。
      if (requested !== undefined && requested !== '' && requested !== currentRoot) {
        saveSettings({ ...loadSettings(), dshVersionDir: versionDir })
      }
      const name = safeVersionName(options?.name)
      const target = join(versionDir, name)
      if (versionExists(target)) {
        // 修复/强制重装：先清掉残缺实例再装（home 由 installOfficialDsh 兜底清）。
        // 非强制则沿用弹窗报错，避免误覆盖一个正常实例。
        if (options?.force === true) {
          await rm(target, { recursive: true, force: true }).catch(() => {})
        } else {
          return fail(E.dshVersionExists, { name })
        }
      }
      const info = await installOfficialDsh(versionDir, name, options?.version,
        step => event.sender.send('install:event', step))
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
      event.sender.send('install:event', { kind: 'register', state: 'running' })
      try {
        writeDshState([...dshes.filter(d => d.id !== entry.id), entry], entry.id)
      } catch (writeError) {
        event.sender.send('install:event', { kind: 'register', state: 'error', detail: String(writeError) })
        throw writeError
      }
      event.sender.send('install:event', { kind: 'register', state: 'ok', version: info.version })
      logger.info(`dsh official installed: ${name} (v${info.version})`)
      return { ok: true, value: info }
  })

  // Official-install version picker: published `@deepseek-ai/dsh` versions.
  handle('dsh:pkgVersions', async (): Promise<IpcResult<PackageVersionInfo>> => ({
    ok: true, value: await fetchPackageVersions('@deepseek-ai/dsh'),
  }))

  // DSH version repository location (settings).
  handle('dsh:getVersionDir', (): IpcResult<{ dir: string }> => ({
    ok: true, value: { dir: dshVersionDir() },
  }))
  handle('dsh:setVersionDir', (_event, dir: string): IpcResult<boolean> =>
    setVersionDirValue(dir))
}