/**
 * Sub-bundle dependency resolution for aggregate plugins. An "aggregate bundle"
 * (e.g. `@linxin666/dsh-web-ui-all`) is one bundle whose patch rows each carry a
 * `name:` pointing at a real sub-package (git-graph, pet, ssh, …). dsh loads those
 * rows by resolving the sub-package from the **profile directory**, so the launcher
 * must link those sub-packages into the profile's node_modules too — otherwise the
 * sub-bundles are installed in the store archive but invisible to the profile, and
 * dsh's Loader fails to resolve them at startup.
 *
 * These helpers compute which sub-packages a bundle pulls in (and where they live)
 * for both the install side (link them into the profile) and the uninstall side
 * (drop their orphaned `link:` deps). They never touch `dsh.profile.bundles` —
 * sub-packages stay out of the layer stack (adding them there would make dsh throw
 * on resolve); they only need to be Node-resolvable from the profile.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseNamedRows } from '../patch/patch.ts'
import { bundlePatchPaths } from './bundle-manifest.ts'

/** The bundle's own package name, for excluding self-references from its sub-set. */
function readBundleName(pkgDir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name?: string }
    return manifest.name === undefined ? undefined : manifest.name
  } catch {
    return undefined
  }
}

/** The distinct sub-packages a bundle's patch references (`name:` rows), excluding
 * the bundle itself and entries without a name. Empty for a non-aggregate bundle.
 *
 * EVERY file the bundle declares is read: a bundle may split its rows over
 * several patch files, and one of the later ones can carry sub-packages the first
 * never mentions. */
export function listBundleSubdepNames(pkgDir: string): string[] {
  const self = readBundleName(pkgDir)
  const seen = new Set<string>()
  const out: string[] = []
  for (const patchPath of bundlePatchPaths(pkgDir)) {
    try {
      for (const row of parseNamedRows(readFileSync(patchPath, 'utf8'))) {
        if (row.name === undefined || row.name === '') continue
        if (row.name === self) continue
        if (seen.has(row.name)) continue
        seen.add(row.name)
        out.push(row.name)
      }
    } catch {
      // An unreadable patch should never break the enclosing install/uninstall.
      continue
    }
  }
  return out
}

/** Resolve a sub-package's on-disk dir from inside an installed bundle's package,
 * mirroring dsh's own `packageDirFromAnchor` (Node's node_modules lookup from the
 * bundle anchor) so the link target is what the Loader would actually resolve. */
export function resolveBundleSubdepDir(pkgDir: string, name: string): string | undefined {
  const anchor = join(pkgDir, 'package.json')
  if (!existsSync(anchor)) return undefined
  for (const searchPath of createRequire(anchor).resolve.paths(name) ?? []) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** The bundle's sub-packages, resolved to their on-disk dirs (those that actually
 * resolve). The install side links each into the profile as `link:<dir>`. */
export function bundleSubdepLinks(pkgDir: string): { name: string; dir: string }[] {
  const out: { name: string; dir: string }[] = []
  for (const name of listBundleSubdepNames(pkgDir)) {
    const dir = resolveBundleSubdepDir(pkgDir, name)
    if (dir !== undefined) out.push({ name, dir })
  }
  return out
}