/**
 * One-time legacy → versioned store migration. The flat layout (a single pnpm
 * project at the store root, every package hoisted under one `node_modules`)
 * predates the multi-version `archive/` layout; the renderer triggers this once
 * (via `store:migrate`) after the user consents, and a hindsight migration
 * marker lets the probe retire later. Read side keeps working on legacy stores.
 */
import { cpSync, existsSync, mkdirSync, realpathSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, normalize } from 'node:path'
import { runPnpm } from './pnpm.ts'
import { dshScopes } from './appState.ts'
import { logger } from './logger.ts'
import {
  initStore, pluginVersionDir, readVersion, storeVersions, type ProfileManifestShape, type StoreManifest,
} from './store-layout.ts'

/** Whether the store still holds legacy flat packages awaiting the one-time
 * migration (top-level node_modules entries not yet absorbed into versions). */
export function needsStoreMigration(storeDir: string): boolean {
  if (storeDir === '') return false
  const manifestPath = join(storeDir, 'package.json')
  if (!existsSync(manifestPath)) return false
  let manifest: StoreManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StoreManifest
  } catch {
    return false
  }
  return Object.keys(manifest.dependencies ?? {}).some(name =>
    existsSync(join(storeDir, 'node_modules', name, 'package.json')) && storeVersions(storeDir, name).length === 0)
}

/** Explicitly run the one-time legacy → versioned migration once the user has
 * consented in the UI. A no-op once the store is already versioned. */
export async function migrateStore(storeDir: string): Promise<void> {
  await migrateLegacyStore(storeDir)
}

export async function migrateLegacyStore(storeDir: string): Promise<void> {
  if (storeDir === '') return
  const manifestPath = join(storeDir, 'package.json')
  if (!existsSync(manifestPath)) return
  let manifest: StoreManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StoreManifest
  } catch {
    return
  }
  const deps = manifest.dependencies ?? {}
  const moves: { old: string; next: string }[] = []
  const archived: string[] = []
  for (const name of Object.keys(deps)) {
    const src = join(storeDir, 'node_modules', name)
    if (!existsSync(join(src, 'package.json'))) continue
    if (storeVersions(storeDir, name).length > 0) {
      // Already present in the archive — no rebuild needed, just retarget links.
      archived.push(name)
      rmSync(src, { recursive: true, force: true })
      logger.info(`store migration: dropped legacy ${name} (already in archive)`)
      continue
    }
    const version = readVersion(src)
    if (version === undefined) continue
    const verDir = pluginVersionDir(storeDir, name, version)
    const archivedTarget = join(verDir, 'node_modules', name)
    if (!existsSync(join(archivedTarget, 'package.json'))) {
      // Copy the package SOURCE (NOT its resolved node_modules) into the archive,
      // then let pnpm re-resolve so each version is self-contained again.
      const srcDir = join(verDir, '.src')
      rmSync(srcDir, { recursive: true, force: true })
      logger.info(`store migration: staging source of ${name}@${version} into archive/`)
      try {
        mkdirSync(verDir, { recursive: true })
        // The top-level node_modules/<name> is a pnpm SYMLINK into .pnpm (its only
        // real entry, everything else is the shared store). Copying the link as-is
        // (cpSync's default dereference:false) yields a link whose target is then
        // removed — a dangling, useless archive — and throws EPERM on Windows
        // without Developer Mode. Resolve the package body first, then copy it.
        cpSync(realpathSync(src), srcDir, { recursive: true, filter: p => basename(p) !== 'node_modules' })
      } catch (error) {
        logger.warn(`store migration: could not stage ${name}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      initStore(verDir)
      // Reuse what the old library already downloaded: pnpm's global content-
      // addressable store holds those deps, so an OFFLINE add hard-links them
      // back fast instead of re-downloading and re-copying node_modules. Only
      // fall back to the network when the offline cache misses.
      logger.info(`store migration: reinstalling ${name}@${version} via pnpm (offline)`)
      const storeOpts = { storeDir }
      const offline = await runPnpm(verDir, ['add', `file:${srcDir}`, '--offline', '--prefer-offline'], undefined, storeOpts)
      if (!offline.ok || !existsSync(join(archivedTarget, 'package.json'))) {
        logger.warn(`store migration: offline reinstall failed for ${name}, retrying online: ${offline.text}`)
        const online = await runPnpm(verDir, ['add', `file:${srcDir}`, '--fetch-retries=3', '--fetch-retry-maxtimeout=60000'], undefined, storeOpts)
        if (!online.ok) {
          logger.warn(`store migration: pnpm reinstall failed for ${name}: ${online.text}`)
          continue
        }
        if (!existsSync(join(archivedTarget, 'package.json'))) {
          logger.warn(`store migration: ${name} did not land in the archive after pnpm add`)
          continue
        }
      }
    }
    moves.push({ old: src, next: archivedTarget })
    archived.push(name)
    rmSync(src, { recursive: true, force: true })
    logger.info(`store migration: archived ${name}@${version}`)
  }
  if (archived.length === 0) return
  for (const name of archived) delete deps[name]
  writeFileSync(manifestPath, JSON.stringify({ name: 'plugin-store', private: true, dependencies: deps }, null, 2) + '\n')
  logger.info(`store migration: completed ${archived.length} plugin(s) into archive/`)
  // Profiles that `link:` into a now-removed top-level path must point at the new
  // archived copy, else their link would go dangling once the dir is gone.
  await rewriteProfileLinks(storeDir, moves)
}

/**
 * Rewrite every profile dependency whose `link:` target was a moved top-level
 * package dir so it points at the new archived copy as a `file:` dependency
 * (the same form installIntoProfile writes today), then re-run pnpm install on
 * the affected profiles so their node_modules real-installs the package. Safe
 * no-op when there are no profiles (or no app-state yet).
 */
async function rewriteProfileLinks(storeDir: string, moves: { old: string; next: string }[]): Promise<void> {
  const redirect = new Map(moves.map(m => [normalize(m.old), normalize(m.next)]))
  logger.info(`store migration: rewriteProfileLinks scanning (${moves.length} moved)`)
  let scopes: Awaited<ReturnType<typeof dshScopes>> = []
  try {
    scopes = dshScopes()
  } catch {
    return // no persisted app state in some environments — nothing to rewrite
  }
  const affected: string[] = []
  for (const dsh of scopes) {
    const base = dsh.profilesDir ?? join(dsh.home, 'profiles')
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const profileDir = join(base, entry.name)
      const mp = join(profileDir, 'package.json')
      if (!existsSync(mp)) continue
      let m: ProfileManifestShape
      try {
        m = JSON.parse(readFileSync(mp, 'utf8'))
      } catch {
        continue
      }
      const deps = m.dependencies ?? {}
      let changed = false
      for (const key of Object.keys(deps)) {
        const spec = deps[key]
        if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
        const target = normalize(spec.slice(5))
        const next = redirect.get(target)
        if (next !== undefined) {
          // Retarget to the archived copy via `file:`, matching what installIntoProfile
          // writes today — NOT `link:`. A `link:` into the store leaves dsh's peers
          // (@deepseek-ai/*) resolving up the store tree and failing; `file:` real-
          // installs the package into the profile so those resolve through the profile
          // → heal-fallback chain, exactly like a freshly-installed plugin.
          deps[key] = `file:${next}`
          changed = true
        }
      }
      if (changed) {
        m.dependencies = deps
        writeFileSync(mp, JSON.stringify(m, null, 2) + '\n')
        affected.push(profileDir)
      }
    }
  }
  logger.info(`store migration: rewriteProfileLinks found ${affected.length} affected profile(s)`)
  for (const pdir of affected) {
    const r = await runPnpm(pdir, ['install', '--config.confirmModulesPurge=false'])
    if (!r.ok) logger.warn(`store migration: profile reinstall failed ${pdir}: ${r.text}`)
  }
  logger.info('store migration: rewriteProfileLinks done')
}