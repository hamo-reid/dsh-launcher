/** Read a profile's manifest (`package.json`): bundle layer + dependencies.
 *
 * The filename, parsing and serialization live in `manifest-file.ts` (a leaf, so
 * `home.ts` can share them); this module is the ctx-aware projection on top. */

import { profileDir } from './home.ts'
import { readRawManifest } from './manifest-file.ts'
import type { DshContext } from './appState.ts'

/** Read the manifest's ordered bundles and dependency names. */
export function readManifest(ctx: DshContext, name: string): { bundles: string[]; dependencies: string[]; displayName: string } {
  const manifest = readRawManifest(profileDir(ctx, name))
  return {
    bundles: manifest.dsh?.profile?.bundles ?? [],
    dependencies: Object.keys(manifest.dependencies ?? {}),
    displayName: manifest.name ?? name,
  }
}
