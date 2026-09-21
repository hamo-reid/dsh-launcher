/**
 * Per-profile launch configuration (saved mode + launch parameters), keyed by a
 * **stable profile id** rather than the mutable profile name.
 *
 * A profile's identity must survive a directory rename and a soft-delete →
 * trash → restore round trip, so keying by name (which changes on rename and can
 * be re-used after a delete) would silently lose or leak defaults. Each profile
 * directory therefore carries a stable id in a sidecar file
 * (`.dsh-launcher-id`), kept OUT of the host `package.json` so dsh never sees an
 * unknown field. Settings keys are `pid:<id>`; the pre-id `<dshId>::<name>`
 * scheme is migrated once at startup by {@link migrateLaunchConfigKeys}.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listProfiles, profileDir } from './home.ts'
import { contextForEntry, readDshState, type DshContext } from './appState.ts'
import { loadSettings, updateSettings } from '../settings/settings.ts'
import { logger } from '../shared/logger.ts'
import type { LaunchOptions, RunMode } from '../../../shared/types.ts'

/** Sidecar filename holding a profile's stable id. */
const ID_FILE = '.dsh-launcher-id'
/** Settings-key prefix marking an id-keyed (current) entry. A key that does not
 * start with this is a legacy `<dshId>::<name>` entry awaiting migration. */
const KEY_PREFIX = 'pid:'

/** Absolute path of a profile directory's id sidecar. */
function profileIdPath(dir: string): string {
  return join(dir, ID_FILE)
}

/** Read a profile directory's stable id; `''` when it has none yet. */
export function readProfileId(dir: string): string {
  try {
    return readFileSync(profileIdPath(dir), 'utf8').trim()
  } catch {
    return ''
  }
}

/** Assign a brand-new stable id to a profile directory (create / clone /
 * import). Overwrites any id copied from a source directory, giving the new
 * profile its own independent launch defaults. */
export function writeNewProfileId(dir: string): string {
  const id = randomUUID()
  writeFileSync(profileIdPath(dir), id)
  return id
}

/** A profile directory's stable id, creating + persisting one on first use so
 * profiles created before ids existed gain one lazily. */
export function ensureProfileId(dir: string): string {
  const existing = readProfileId(dir)
  if (existing !== '') return existing
  const id = randomUUID()
  try {
    // `wx` fails if a concurrent caller created the file first; keep theirs.
    writeFileSync(profileIdPath(dir), id, { flag: 'wx' })
  } catch {
    /* raced: another writer won */
  }
  return readProfileId(dir) || id
}

/** The stable id of one profile under a dsh (creating it if absent). */
export function profileId(ctx: DshContext, name: string): string {
  return ensureProfileId(profileDir(ctx, name))
}

/** The settings key for a profile id. */
function key(id: string): string {
  return `${KEY_PREFIX}${id}`
}

/** The saved launch parameters for a profile id, or `{}` when none were stored. */
export function readLaunchOptions(id: string): LaunchOptions {
  return loadSettings().launchOptions?.[key(id)] ?? {}
}

/** Persist (replace) a profile's saved launch parameters. */
export function writeLaunchOptions(id: string, options: LaunchOptions): void {
  updateSettings((draft) => {
    draft.launchOptions = { ...(draft.launchOptions ?? {}), [key(id)]: options }
  })
}

/** The last run mode for a profile id (`'app'` when unset). */
export function readRunMode(id: string): RunMode {
  return loadSettings().runModes?.[key(id)] === 'shell' ? 'shell' : 'app'
}

/** Persist the last run mode for a profile id. */
export function writeRunMode(id: string, mode: RunMode): void {
  updateSettings((draft) => {
    draft.runModes = { ...(draft.runModes ?? {}), [key(id)]: mode }
  })
}

/** Drop one profile's saved launch config (permanent delete / dsh removal). The
 * optional `legacy` key additionally clears a pre-migration `<dshId>::<name>`
 * entry. A no-op (no settings write) when neither key is present. */
export function clearLaunchConfig(id: string, legacy?: string): void {
  const k = key(id)
  const snapshot = loadSettings()
  const present = (map: Record<string, unknown> | undefined): boolean =>
    map !== undefined && (map[k] !== undefined || (legacy !== undefined && map[legacy] !== undefined))
  if (!present(snapshot.launchOptions) && !present(snapshot.runModes)) return
  updateSettings((draft) => {
    const drop = <T>(map: Record<string, T> | undefined): Record<string, T> | undefined => {
      if (map === undefined) return map
      if (map[k] === undefined && (legacy === undefined || map[legacy] === undefined)) return map
      const next = { ...map }
      if (next[k] !== undefined) delete next[k]
      if (legacy !== undefined) delete next[legacy]
      return next
    }
    draft.launchOptions = drop(draft.launchOptions)
    draft.runModes = drop(draft.runModes)
  })
}

/** List a dsh's profile names, tolerating a missing/unreadable profiles dir. */
function safeProfiles(ctx: DshContext): string[] {
  try {
    return listProfiles(ctx)
  } catch {
    return []
  }
}

/** Clear every profile's saved launch config under one dsh (its removal). Must
 * run BEFORE the install's files are deleted — the ids live in the profile
 * directories. `dshId` is the registry id used by the legacy key form. */
export function clearDshLaunchConfig(dshId: string, ctx: DshContext): void {
  for (const name of safeProfiles(ctx)) {
    const id = readProfileId(profileDir(ctx, name))
    if (id === '') continue
    clearLaunchConfig(id, `${dshId}::${name}`)
  }
}

/**
 * One-time migration from the legacy `<dshId>::<name>` key scheme to stable
 * profile ids. Idempotent and cheap when nothing is legacy (the common case on
 * every start after the first): it returns immediately unless a non-`pid:` key
 * exists. Legacy keys whose profile no longer exists are dropped.
 */
export function migrateLaunchConfigKeys(): void {
  const s = loadSettings()
  const launch = s.launchOptions ?? {}
  const modes = s.runModes ?? {}
  const hasLegacy = [...Object.keys(launch), ...Object.keys(modes)].some(k => !k.startsWith(KEY_PREFIX))
  if (!hasLegacy) return

  // Keep entries already on the current scheme; rebuild legacy ones below.
  const nextLaunch: Record<string, LaunchOptions> = {}
  const nextModes: Record<string, RunMode> = {}
  for (const [k, v] of Object.entries(launch)) if (k.startsWith(KEY_PREFIX)) nextLaunch[k] = v
  for (const [k, v] of Object.entries(modes)) if (k.startsWith(KEY_PREFIX)) nextModes[k] = v

  let moved = 0
  for (const entry of readDshState().dshes) {
    const ctx = contextForEntry(entry)
    for (const name of safeProfiles(ctx)) {
      const legacy = `${entry.id}::${name}`
      const hasLaunch = launch[legacy] !== undefined
      const hasMode = modes[legacy] !== undefined
      if (!hasLaunch && !hasMode) continue
      const id = profileId(ctx, name)
      if (hasLaunch) nextLaunch[key(id)] = launch[legacy]
      if (hasMode) nextModes[key(id)] = modes[legacy]
      moved += 1
    }
  }
  updateSettings((draft) => {
    draft.launchOptions = nextLaunch
    draft.runModes = nextModes
  })
  logger.info(`launch config migrated to stable profile ids (${moved} profile(s))`)
}
