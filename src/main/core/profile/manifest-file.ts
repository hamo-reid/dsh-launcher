/**
 * A profile manifest (`package.json`) on disk: its filename, its parsed shape, and
 * the exact byte form the launcher writes.
 *
 * These primitives take a path or a directory rather than a {@link DshContext}, and
 * import nothing from `core` — which is what lets `core/profile/home.ts` use them. The
 * filename and the serialization are needed on both sides of `manifest.ts`'s
 * dependency on `home.ts`, and a leaf module is the alternative to a cycle.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProfilePatchReload } from '../../../shared/types.ts'

export const MANIFEST_FILE_NAME = 'package.json'

/** A profile manifest, uninterpreted — every field the launcher reads or writes. */
interface RawManifest {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[]; patchReload?: ProfilePatchReload } }
}

/** The manifest's on-disk byte form: 2-space JSON with a trailing newline, the
 * shape dsh's own tooling writes. */
function stringifyManifest(manifest: RawManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n'
}

/** Read one manifest file. Throws on a malformed document — a corrupt manifest is
 * an error the caller must see, never an empty profile. */
export function readManifestFile(path: string): RawManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as RawManifest
}

/** Write one manifest file. */
export function writeManifestFile(path: string, manifest: RawManifest): void {
  writeFileSync(path, stringifyManifest(manifest))
}

/** Read a profile directory's manifest. */
export function readRawManifest(dir: string): RawManifest {
  const path = join(dir, MANIFEST_FILE_NAME)
  if (!existsSync(path)) throw new Error(`profile 不存在：${dir}`)
  return readManifestFile(path)
}

/** Write a profile directory's manifest. */
export function writeRawManifest(dir: string, manifest: RawManifest): void {
  writeManifestFile(join(dir, MANIFEST_FILE_NAME), manifest)
}
