/**
 * Packing a dev package for the store: `pnpm pack` in the user's own repo.
 *
 * Why pack and not a plain `file:<dir>` add: a dev plugin is developed inside a
 * pnpm monorepo, so its manifest speaks protocols only that monorepo can
 * resolve — `workspace:*`, `workspace:^`, `catalog:`. Added from outside it, the
 * store's staging project fails with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` and
 * nothing gets archived at all. `pnpm pack` is the same rewrite `npm publish`
 * performs, and it is the one that already decides what a package ships:
 *
 *   workspace:*  →  3.2.1        workspace:^  →  ^3.2.1        catalog:  →  ^4.1.0
 *
 * It also honours the package's `files` allowlist, so the archive holds the
 * publishable payload rather than a whole source tree.
 *
 * It runs in the USER's repo, so it uses that repo's store (`skipStoreDir`) and
 * its own `prepack` scripts run — which is how a snapshot gets a fresh build.
 * The one precondition is that the monorepo is installed; pnpm resolves the
 * workspace protocol from the installed tree, so an uninstalled repo reports
 * `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`. That is reported as
 * `needsInstall` rather than as a failure, because the fix is one command the
 * launcher already offers.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runPnpm } from '../dsh/pnpm.ts'
import { logger } from '../shared/logger.ts'
import { pathIdentifierInvalid, versionInvalid } from '../profile/name-guard.ts'
import type { DevPlugin, DevRunResult } from '../../../shared/types.ts'

/** pnpm's error when a workspace/catalog protocol cannot be resolved because the
 * dependency is not installed. Recoverable by installing the dev repo. */
const NEEDS_INSTALL = 'ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL'

/** pnpm's error when a resolved version is not in the registry at all. */
const UNPUBLISHED = /ERR_PNPM_(FETCH_404|NO_MATCHING_VERSION)/

/**
 * Explain the ARCHIVE step's own version of the same problem.
 *
 * `pnpm pack` rewrites `workspace:*` into a real version, which is correct — but
 * if that package only ever existed inside the monorepo, the rewritten version
 * is not on the registry and `pnpm add file:<tarball>` fails with a bare 404.
 * pnpm's message names the request, not the remedy, and the user is left
 * guessing whether to publish, to re-tag, or to give up on the snapshot.
 * `undefined` means "not this", so the caller's own error text is kept.
 */
export function explainArchiveFailure(text: string): string | undefined {
  if (!UNPUBLISHED.test(text)) return undefined
  const tail = text.trim().split(/\r?\n/).slice(-4).join(' ')
  return '打包后的依赖里有 registry 上不存在的版本——多半是只在 monorepo 内部使用、从未发布过的包。'
    + '快照无法完成：请先发布它，或把它改为 peerDependencies（由宿主在运行时提供）。\n'
    + tail
}

/**
 * Where packed tarballs are kept: `<storeDir>/.pack/<name>/<version>/`.
 *
 * Per VERSION, not per package, and that is load-bearing. The archive records
 * `file:<tarball>` as its own dependency, so its `pnpm install` re-resolves
 * through this path for as long as that archive exists — a repair or a rebuild of
 * an OLD archived version reads it. One directory per package meant a version bump
 * deleted the tarball the previous archive still points at, and that version could
 * never be rebuilt again. The dev package's own `version` decides the segment, so
 * a re-snapshot of the SAME version still replaces its own tarball (deliberate:
 * the source moved, the number did not), while a different version keeps its own.
 */
export function packDir(storeDir: string, name: string, version: string): string {
  return join(storeDir, '.pack', name, version)
}

/** A pack run: pnpm's own output plus where the tarball landed. */
export interface PackResult extends DevRunResult {
  /** The packed tarball, when the run produced one. */
  tgz?: string
  /** The dev repo's own dependencies must be installed before it can be packed. */
  needsInstall?: boolean
}

/** The dev package's declared name and version, or `undefined` when unreadable. */
function packIdentity(dir: string): { name: string; version: string } | undefined {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
    const name = typeof m.name === 'string' ? m.name.trim() : ''
    if (name === '') return undefined
    return { name, version: typeof m.version === 'string' ? m.version.trim() : '' }
  } catch {
    return undefined
  }
}

/** The single tarball a fresh pack run left in `dir` (`undefined` when there is
 * not exactly one, which means the run did not do what it was asked). */
function packedTarball(dir: string): string | undefined {
  const found = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.tgz'))
  return found.length === 1 ? join(dir, found[0]) : undefined
}

/**
 * Pack `dev` into `<storeDir>/.pack/<name>/<version>/`, replacing whatever was in
 * THAT version's directory so a stale tarball can never be mistaken for this run's
 * output — while every other version's tarball stays where the archives that
 * depend on it expect to find it.
 */
export async function packDevPackage(dev: DevPlugin, storeDir: string): Promise<PackResult> {
  if (storeDir === '') {
    return { ok: false, text: '未配置插件保存位置 —— 请在「设置」中指定', command: '', cwd: dev.dir }
  }
  const id = packIdentity(dev.dir)
  if (id === undefined) {
    return { ok: false, text: `插件包缺少 name 字段或 package.json 不可读：${dev.dir}`, command: '', cwd: dev.dir }
  }
  // The name becomes `<store>/.pack/<name>`, which is recursively removed just
  // below — the same untrusted field `installSource` guards, and it is the dev
  // package's OWN manifest that supplies it. A scoped name keeps its one
  // legitimate `/` (`@scope/name` nests inside `.pack`, still in the store).
  if (pathIdentifierInvalid(id.name)) {
    return { ok: false, text: `插件包名不合法：${id.name}`, command: '', cwd: dev.dir }
  }
  // The version is a path segment now too (see `packDir`), from the same manifest,
  // and that directory is recursively removed below: `..` there would step out of
  // `.pack` — or out of the store — and delete what it found. `versionInvalid` also
  // rejects the empty string, which would collapse the path back to the
  // all-versions directory this exists to avoid.
  if (versionInvalid(id.version)) {
    return { ok: false, text: `插件包声明的版本号不可用：${id.version}`, command: '', cwd: dev.dir }
  }
  const dest = packDir(storeDir, id.name, id.version)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })

  const args = ['pack', '--pack-destination', dest]
  const result = await runPnpm(dev.dir, args, undefined, { skipStoreDir: true })
  const command = result.command ?? `pnpm ${args.join(' ')}`
  if (!result.ok) {
    const needsInstall = result.text.includes(NEEDS_INSTALL)
    rmSync(dest, { recursive: true, force: true })
    logger.warn(`dev pack failed: ${id.name} (${needsInstall ? 'needs install' : 'error'})`)
    return {
      ok: false,
      text: needsInstall
        ? '源码仓库的依赖尚未安装，无法解析 workspace 依赖。请先在该仓库执行 pnpm install。'
        : result.text,
      command,
      cwd: dev.dir,
      ...(needsInstall ? { needsInstall: true } : {}),
    }
  }
  const tgz = packedTarball(dest)
  if (tgz === undefined || !existsSync(tgz)) {
    rmSync(dest, { recursive: true, force: true })
    return { ok: false, text: `pnpm pack 未产出 .tgz（${dest}）`, command, cwd: dev.dir }
  }
  logger.info(`dev pack: ${id.name} → ${tgz}`)
  return { ok: true, text: result.text, command, cwd: dev.dir, tgz }
}
