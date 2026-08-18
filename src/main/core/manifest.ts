/** Read a profile's manifest (`package.json`): bundle layer + dependencies. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { profileDir } from './home.ts'

interface ManifestShape {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
  name?: string
}

/** Read the manifest's ordered bundles and dependency names. */
export function readManifest(name: string): { bundles: string[]; dependencies: string[]; displayName: string } {
  const manifest = JSON.parse(readFileSync(join(profileDir(name), 'package.json'), 'utf8')) as ManifestShape
  return {
    bundles: manifest.dsh?.profile?.bundles ?? [],
    dependencies: Object.keys(manifest.dependencies ?? {}),
    displayName: manifest.name ?? name,
  }
}