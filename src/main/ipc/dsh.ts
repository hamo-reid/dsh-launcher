/** IPC for dsh installs (`dsh:*`): registry, activation, home/profile-dir, and
 * official installation. */

import { ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import {
  baseLaunch, defaultHome, entryFromPath, installDir, probeDshs, readVersionFromPath, resolveDshPackage, type DshEntry,
} from '../core/dsh.ts'
import {
  dshVersionDir, effectiveProfileDir, readDshState, writeDshState,
} from '../core/appState.ts'
import { loadSettings, saveSettings } from '../core/settings.ts'
import { runPnpm } from '../core/pnpm.ts'
import { fetchPackageVersions } from '../core/npm.ts'
import { fail, failFromError, E } from '../core/errors.ts'
import { logger } from '../core/logger.ts'
import type { IpcResult, PackageVersionInfo } from '../../shared/types.ts'

/** A filesystem-safe version name (defaults to `official`). */
function safeVersionName(name: string | undefined): string {
  const cleaned = (name ?? '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-').trim()
  return cleaned === '' ? 'official' : cleaned
}

/** Install the official `@deepseek-ai/dsh` into `<versionDir>/<name>` with its
 * own home under `<versionDir>/../homes/<name>`. `version` selects a published
 * version from npm (`@deepseek-ai/dsh@<v>`); when empty, the latest is installed. */
async function installOfficialDsh(versionDir: string, name: string, version?: string): Promise<{ execPath: string; version: string; home: string; dir: string }> {
  const target = join(versionDir, name)
  const home = join(dirname(versionDir), 'homes', name)
  mkdirSync(target, { recursive: true })
  // 版本可空（回落 latest），指定则装 npm 上的对应发布版。
  const spec = version !== undefined && version.trim() !== ''
    ? `@deepseek-ai/dsh@${version.trim()}`
    : '@deepseek-ai/dsh'
  const result = await runPnpm(target, ['add', spec])
  if (!result.ok) throw new Error(`安装官方 dsh 失败：${result.text}`)

  const binCandidates = [
    join(target, 'node_modules', '.bin', 'dsh.cmd'),
    join(target, 'node_modules', '.bin', 'dsh'),
    join(target, 'node_modules', 'dsh', 'bin', 'dsh'),
  ]
  const execPath = binCandidates.find(candidate => existsSync(candidate))
    ?? join(target, 'node_modules', '.bin', 'dsh')

  let installedVersion = 'unknown'
  try {
    const manifestPath = join(target, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string }
    installedVersion = manifest.version ?? installedVersion
  } catch {
    // fall back to 'unknown'
  }
  return { execPath, version: installedVersion, home, dir: target }
}

/** Physically delete a dsh install. App-managed version instances (under the
 * dsh version repo) are removed wholesale together with their dedicated home;
 * otherwise the directory owning the executable is removed.
 *
 * Async deletion via `fs/promises.rm` so the huge node_modules tree does not
 * block the main process's event loop (which would make the whole app hang). */
async function deleteDshFiles(entry: DshEntry): Promise<void> {
  const execDir = installDir(entry.execPath)
  const versionRoot = dshVersionDir()
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
  ipcMain.handle('dsh:list', (): IpcResult<{ dshes: DshEntry[]; activeDshId?: string }> => {
    try {
      const { dshes, activeDshId } = readDshState()
      return {
        ok: true,
        value: {
          dshes: dshes.map(d => {
            // 精确定位 dsh 包根：版本读 `@deepseek-ai/dsh`（或 apps/cli）的 package.json，
            // 所在位置指向包根而非 `.bin` shim 目录。shim 上旧式暴力上溯会读错版本。
            const resolved = resolveDshPackage(d.execPath)
            return {
              ...d,
              version: resolved?.version ?? d.version ?? readVersionFromPath(d.execPath),
              launch: baseLaunch(d.execPath),
              profileDir: effectiveProfileDir(d),
              dir: resolved?.root ?? installDir(d.execPath),
            }
          }),
          activeDshId,
        },
      }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Reveal a dsh's install directory in the OS file explorer.
  ipcMain.handle('dsh:revealDir', async (_event, id: string): Promise<IpcResult<boolean>> => {
    try {
      const { dshes } = readDshState()
      const entry = dshes.find(d => d.id === id)
      if (entry === undefined) return fail(E.dshNotFound)
      const error = await shell.openPath(installDir(entry.execPath))
      return error === '' ? { ok: true, value: true } : fail('shell.openPath', { detail: error })
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('dsh:detect', async (): Promise<IpcResult<DshEntry[]>> => {
    try {
      return { ok: true, value: await probeDshs() }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('dsh:add', async (_event, path: string): Promise<IpcResult<DshEntry>> => {
    try {
      let entry: DshEntry
      try {
        entry = await entryFromPath(path)
      } catch {
        // Not a real filesystem path — e.g. a command string like
        // `node --import tsx/esm "…"`. Register it as-is (version unknown).
        entry = { id: path, name: 'dsh (manual)', execPath: path, version: '', home: defaultHome() }
      }
      const { dshes } = readDshState()
      writeDshState([...dshes.filter(d => d.id !== entry.id), entry])
      return { ok: true, value: entry }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('dsh:remove', async (_event, id: string, opts?: { deleteFiles?: boolean }): Promise<IpcResult<boolean>> => {
    try {
      const { dshes, activeDshId } = readDshState()
      const entry = dshes.find(d => d.id === id)
      // 非 app 管理的（系统级/手动加入的用户已有安装）一律禁止删除，
      // 避免误删用户全局环境或绕过 UI 的 `dsh:remove` 调用。
      if (entry !== undefined && entry.managed !== true) {
        return fail('dsh.protected')
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
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('dsh:setActive', (_event, id: string): IpcResult<boolean> => {
    try {
      const { dshes } = readDshState()
      const d = dshes.find(candidate => candidate.id === id)
      if (d === undefined) return fail(E.dshNotFound)
      writeDshState(dshes, id)
      logger.info(`dsh activated: ${d.name}`)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('dsh:setHome', (_event, id: string, home: string): IpcResult<boolean> => {
    try {
      const { dshes, activeDshId } = readDshState()
      const next = dshes.map(d => d.id === id ? { ...d, home } : d)
      writeDshState(next, activeDshId)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('dsh:setProfileDir', (_event, id: string, dir: string): IpcResult<boolean> => {
    try {
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
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('dsh:rename', (_event, id: string, name: string): IpcResult<boolean> => {
    try {
      const trimmed = name.trim()
      if (trimmed === '') return fail(E.nameInvalid)
      const { dshes, activeDshId } = readDshState()
      if (!dshes.some(d => d.id === id)) return fail(E.dshNotFound)
      writeDshState(dshes.map(d => d.id === id ? { ...d, name: trimmed } : d), activeDshId)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('dsh:addManual', (_event, alias: string, execPath: string): IpcResult<DshEntry> => {
    try {
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
      writeDshState([...dshes.filter(d => d.id !== entry.id), entry])
      return { ok: true, value: entry }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('dsh:probe', async (_event, path?: string): Promise<IpcResult<DshEntry[]>> => {
    try {
      // No path → probe the system; a path → probe that single candidate.
      if (path === undefined || path === '') return { ok: true, value: await probeDshs() }
      return { ok: true, value: [await entryFromPath(path)] }
    } catch (error) {
      return failFromError(error)
    }
  })

  ipcMain.handle('dsh:installOfficial', async (_event, options?: { versionDir?: string; name?: string; version?: string }): Promise<IpcResult<boolean>> => {
    try {
      const versionDir = options?.versionDir?.trim() !== undefined && options.versionDir.trim() !== ''
        ? options.versionDir.trim()
        : dshVersionDir()
      const name = safeVersionName(options?.name)
      // 版本名冲突检测：target 目录已存在且非空则拒绝（避免覆盖既有实例）。
      const target = join(versionDir, name)
      if (existsSync(target) && readdirSync(target).length > 0) {
        return fail('dsh.versionExists', { name })
      }
      const info = await installOfficialDsh(versionDir, name, options?.version)
      const { dshes } = readDshState()
      const entry: DshEntry = {
        id: info.execPath,
        name,
        execPath: info.execPath,
        version: info.version,
        home: info.home,
        // App-managed (in the version repo) — the only kind deletable from the DSH page.
        managed: true,
      }
      writeDshState([...dshes.filter(d => d.id !== entry.id), entry], entry.id)
      logger.info(`dsh official installed: ${name} (v${info.version})`)
      return { ok: true, value: true }
    } catch (error) {
      return failFromError(error)
    }
  })

  // Official-install version picker: published `@deepseek-ai/dsh` versions.
  ipcMain.handle('dsh:pkgVersions', async (): Promise<IpcResult<PackageVersionInfo>> => {
    try {
      return { ok: true, value: await fetchPackageVersions('@deepseek-ai/dsh') }
    } catch (error) {
      return failFromError(error)
    }
  })

  // DSH version repository location (settings).
  ipcMain.handle('dsh:getVersionDir', (): IpcResult<{ dir: string }> => {
    try {
      return { ok: true, value: { dir: dshVersionDir() } }
    } catch (error) {
      return failFromError(error)
    }
  })
  ipcMain.handle('dsh:setVersionDir', (_event, dir: string): IpcResult<boolean> =>
    setVersionDirValue(dir))
}