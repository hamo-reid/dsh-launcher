/**
 * The patch files a bundle package composes, read from its `dsh.bundle.patch`
 * declaration.
 *
 * dsh accepts one path or an ordered LIST of paths, and the list form is not
 * exotic: 0.2.0-rc.1's `@deepseek-ai/dsh-web-app` declares five files, four of
 * them the agent-preset declarations under `presets/`. One reader for that
 * declaration, because every consumer that re-derived it got the list wrong in
 * its own way — the patch-layer walk read the first file and silently lost every
 * later one (which is how the whole preset roster went missing), and the
 * sub-bundle scan handed the list to `path.join` and threw on the profile's own
 * web bundle.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PATCH_FILE_NAME } from '../patch/patch.ts'

/** A `dsh.bundle.patch` value as its file list: one path, or an ordered list.
 * Unusable entries are dropped; anything else declares nothing. */
function patchFiles(declared: unknown): string[] {
  if (typeof declared === 'string') return declared.trim() === '' ? [] : [declared]
  if (Array.isArray(declared)) {
    return declared.filter((file): file is string => typeof file === 'string' && file.trim() !== '')
  }
  return []
}

/** The patch files a package declares, as written. Empty when it declares none,
 * or when its manifest is missing or unreadable. */
export function declaredBundlePatches(pkgDir: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: unknown } }
    }
    return patchFiles(manifest.dsh?.bundle?.patch)
  } catch {
    // A missing or invalid manifest is not a declaration.
    return []
  }
}

/**
 * The filenames to look for inside a bundle dir: the declared ones, else the
 * historical `cordis.patch.yml`.
 *
 * The host requires the declaration and fails loud without it; the launcher is a
 * viewer, so a package that omits it still resolves by filename.
 */
export function bundlePatchRels(bundleDir: string): string[] {
  const declared = declaredBundlePatches(bundleDir)
  return declared.length > 0 ? declared : [PATCH_FILE_NAME]
}

/** A bundle's patch files as absolute paths, in declared order, skipping the ones
 * that are absent. Empty for a package that carries no patch. */
export function bundlePatchPaths(pkgDir: string): string[] {
  return bundlePatchRels(pkgDir)
    .map(rel => join(pkgDir, rel))
    .filter(path => existsSync(path))
}
