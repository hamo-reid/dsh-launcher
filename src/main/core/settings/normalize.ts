/**
 * The settings shape and its coercion: what the stored rows may contain, and how
 * an arbitrary parsed value becomes a valid `AppSettings`.
 *
 * Pure — no module state, no database, no filesystem. That is what lets the
 * field-by-field defenses be read and tested without the store around them.
 */
import type { DshEntry } from '../dsh/dsh.ts'
import type { DevPlugin, LaunchOptions, MarketSource, McpLibEntry, RunMode } from '../../../shared/types.ts'

/** The merged settings shape callers see (a union of the three stored rows). */
export interface AppSettings {
  /** Directory where downloaded/installed plugins are kept. */
  pluginDir?: string
  /** Base directory holding the local dsh version repository (one subdir per version). */
  dshVersionDir?: string
  /** Registered dsh installs. */
  dshes?: DshEntry[]
  /** Persisted UI language (`'zh'`/`'en'` …). */
  uiLanguage?: string
  /** Whether clicking close minimizes to the system tray instead of quitting.
   * Defaults to `true`; a false (or absent-on-older-schema) value quits. */
  closeToTray?: boolean
  /** Whether clicking close asks the user (minimize-to-tray vs quit) each time.
   * Defaults to `true`; a false value uses `closeToTray` directly without
   * prompting (set both when the user ticks "don't ask again"). */
  askOnClose?: boolean
  /** Which node to run dsh with when the user chooses explicitly. `'system'`
   * uses a usable system node (falling back to bundled if none/too old);
   * `'bundled'` always uses the bundled Node. Defaults to `'system'`. */
  nodePreference?: 'system' | 'bundled'
  /** Whether the first-run onboarding wizard has been completed. */
  onboarded?: boolean
  /** Which origin the community market loads its catalog from (`'official'`
   * = the canonical `plugins.json`; `'custom'` = a user-supplied mirror URL). */
  marketSource?: MarketSource
  /** Custom market catalog URL, used when `marketSource === 'custom'`. */
  marketUrl?: string
  /** The user's GitHub token, encrypted at rest (see `core/github/auth.ts`).
   * A secret: never exported and never logged. */
  githubTokenEnc?: string
  /** MCP launch secrets, name → value encrypted at rest (see
   * `core/mcp/secrets.ts`). Injected into every dsh child's environment so the
   * `!!js process.env.<NAME>` references in MCP rows resolve. Secrets: never
   * exported and only the names ever cross to the renderer. */
  mcpSecrets?: Record<string, string>
  /** The launcher-global MCP server library (see `core/mcp/library.ts`).
   * Definitions, not secrets — exported with settings backups. */
  mcpLibrary?: McpLibEntry[]
  /** Registered local development plugins (linked, not archived). Launcher-only
   * state: independent of the plugin store. */
  devPlugins?: DevPlugin[]
  /** Saved default launch parameters, keyed `pid:<profileId>` (a stable id
   * stored in each profile dir; see `core/profile/launch-config.ts`). Kept out of the
   * profile manifest on purpose so machine-specific patch paths never leak into
   * an exported/imported profile. */
  launchOptions?: Record<string, LaunchOptions>
  /** Last run mode per stable profile id, keyed `pid:<profileId>`, so relaunching
   * keeps the user's app/shell choice instead of resetting to `app`. */
  runModes?: Record<string, RunMode>
}

/** The `prefs` row: user preferences (no registry / no per-profile config). */
export type PrefsSettings = Pick<AppSettings,
  'pluginDir' | 'dshVersionDir' | 'uiLanguage' | 'closeToTray' | 'askOnClose' |
  'nodePreference' | 'onboarded' | 'marketSource' | 'marketUrl' | 'githubTokenEnc' |
  'mcpSecrets' | 'mcpLibrary' | 'devPlugins'>
/** The `dsh` row: the registered dsh installs. */
export type DshSettings = Pick<AppSettings, 'dshes'>
/** The `launch` row: per-profile launch config. */
export type LaunchSettings = Pick<AppSettings, 'launchOptions' | 'runModes'>

/** Current on-disk schema version. Bump when a migration is added. */
export const CURRENT_SCHEMA_VERSION = 1

type Migration = (s: AppSettings) => AppSettings
/** Ordered migrations keyed by the version they upgrade FROM (`v → v+1`).
 * 0 → 1 is the storage split, handled structurally, so no data-shape step. */
const MIGRATIONS: Record<number, Migration> = {}

export function splitPrefs(s: AppSettings): PrefsSettings {
  return {
    ...(s.pluginDir !== undefined ? { pluginDir: s.pluginDir } : {}),
    ...(s.dshVersionDir !== undefined ? { dshVersionDir: s.dshVersionDir } : {}),
    ...(s.uiLanguage !== undefined ? { uiLanguage: s.uiLanguage } : {}),
    ...(s.closeToTray !== undefined ? { closeToTray: s.closeToTray } : {}),
    ...(s.askOnClose !== undefined ? { askOnClose: s.askOnClose } : {}),
    ...(s.nodePreference !== undefined ? { nodePreference: s.nodePreference } : {}),
    ...(s.onboarded !== undefined ? { onboarded: s.onboarded } : {}),
    ...(s.marketSource !== undefined ? { marketSource: s.marketSource } : {}),
    ...(s.marketUrl !== undefined ? { marketUrl: s.marketUrl } : {}),
    ...(s.githubTokenEnc !== undefined ? { githubTokenEnc: s.githubTokenEnc } : {}),
    ...(s.mcpSecrets !== undefined ? { mcpSecrets: s.mcpSecrets } : {}),
    ...(s.mcpLibrary !== undefined ? { mcpLibrary: s.mcpLibrary } : {}),
    ...(s.devPlugins !== undefined ? { devPlugins: s.devPlugins } : {}),
  }
}

export function splitDsh(s: AppSettings): DshSettings {
  return s.dshes !== undefined ? { dshes: s.dshes } : {}
}

export function splitLaunch(s: AppSettings): LaunchSettings {
  const out: LaunchSettings = {}
  if (s.launchOptions !== undefined) out.launchOptions = s.launchOptions
  if (s.runModes !== undefined) out.runModes = s.runModes
  return out
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isDshEntry(v: unknown): v is DshEntry {
  return isRecord(v) && typeof v.id === 'string' && typeof v.execPath === 'string' && typeof v.home === 'string'
}

/** Normalize the dev-plugin registry. Entries need a name + dir; the rest is
 * best-effort, since settings may be hand-edited or written by an older build. */
function readDevPlugins(raw: unknown): DevPlugin[] {
  if (!Array.isArray(raw)) return []
  const out: DevPlugin[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const dir = typeof item.dir === 'string' ? item.dir.trim() : ''
    if (name === '' || dir === '') continue
    const shims = Array.isArray(item.shims) ? item.shims.filter((s): s is string => typeof s === 'string') : []
    const rawBuild = item.build
    const build = isRecord(rawBuild) && typeof rawBuild.script === 'string' && rawBuild.script.trim() !== ''
      ? { script: rawBuild.script.trim(), scope: rawBuild.scope === 'workspace' ? 'workspace' as const : 'package' as const }
      : undefined
    out.push({
      name,
      dir,
      ...(typeof item.workspaceRoot === 'string' && item.workspaceRoot !== '' ? { workspaceRoot: item.workspaceRoot } : {}),
      ...(typeof item.version === 'string' && item.version !== '' ? { version: item.version } : {}),
      bundle: item.bundle === true,
      ...(build !== undefined ? { build } : {}),
      ...(shims.length > 0 ? { shims } : {}),
      addedAt: typeof item.addedAt === 'string' && item.addedAt !== '' ? item.addedAt : new Date(0).toISOString(),
    })
  }
  return out
}

/** Normalize the MCP library: entries need a valid `serverName` and an input
 * object; everything else is best-effort (settings may be hand-edited). */
function readMcpLibrary(raw: unknown[]): McpLibEntry[] {
  const out: McpLibEntry[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const serverName = typeof item.serverName === 'string' ? item.serverName : ''
    if (serverName === '' || !isRecord(item.input)) continue
    out.push({
      serverName,
      input: item.input as unknown as McpLibEntry['input'],
      updatedAt: typeof item.updatedAt === 'string' && item.updatedAt !== '' ? item.updatedAt : new Date(0).toISOString(),
    })
  }
  return out
}

/** Coerce an arbitrary parsed value into a valid `AppSettings`, dropping bad
 * fields. Defends against hand-edited / partially-corrupt input. */

export function normalizeSettings(raw: unknown): AppSettings {
  if (!isRecord(raw)) return {}
  const out: AppSettings = {}
  const nonEmptyString = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v : undefined
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

  const pluginDir = nonEmptyString(raw.pluginDir)
  if (pluginDir !== undefined) out.pluginDir = pluginDir
  const dshVersionDir = nonEmptyString(raw.dshVersionDir)
  if (dshVersionDir !== undefined) out.dshVersionDir = dshVersionDir
  const uiLanguage = nonEmptyString(raw.uiLanguage)
  if (uiLanguage !== undefined) out.uiLanguage = uiLanguage
  const closeToTray = bool(raw.closeToTray)
  if (closeToTray !== undefined) out.closeToTray = closeToTray
  const askOnClose = bool(raw.askOnClose)
  if (askOnClose !== undefined) out.askOnClose = askOnClose
  if (raw.nodePreference === 'system' || raw.nodePreference === 'bundled') out.nodePreference = raw.nodePreference
  const onboarded = bool(raw.onboarded)
  if (onboarded !== undefined) out.onboarded = onboarded
  if (raw.marketSource === 'official' || raw.marketSource === 'custom') out.marketSource = raw.marketSource
  const marketUrl = nonEmptyString(raw.marketUrl)
  if (marketUrl !== undefined) out.marketUrl = marketUrl
  const githubTokenEnc = nonEmptyString(raw.githubTokenEnc)
  if (githubTokenEnc !== undefined) out.githubTokenEnc = githubTokenEnc
  if (isRecord(raw.mcpSecrets)) {
    const secrets: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw.mcpSecrets)) {
      if (typeof value === 'string' && value !== '' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) secrets[key] = value
    }
    if (Object.keys(secrets).length > 0) out.mcpSecrets = secrets
  }
  if (Array.isArray(raw.mcpLibrary)) out.mcpLibrary = readMcpLibrary(raw.mcpLibrary)
  if (Array.isArray(raw.dshes)) out.dshes = raw.dshes.filter(isDshEntry)
  const devPlugins = readDevPlugins(raw.devPlugins)
  if (devPlugins.length > 0) out.devPlugins = devPlugins
  if (isRecord(raw.launchOptions)) out.launchOptions = raw.launchOptions as Record<string, LaunchOptions>
  if (isRecord(raw.runModes)) {
    const modes: Record<string, RunMode> = {}
    for (const [key, value] of Object.entries(raw.runModes)) if (value === 'app' || value === 'shell') modes[key] = value
    out.runModes = modes
  }
  return out
}

export function runMigrations(data: AppSettings, from: number): { data: AppSettings; version: number } {
  let next = data
  let version = from
  while (version < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version]
    if (step !== undefined) next = step(next)
    version += 1
  }
  return { data: next, version: Math.max(version, from) }
}
