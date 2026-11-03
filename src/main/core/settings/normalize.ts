/**
 * The settings shape and its coercion: what the stored rows may contain, and how
 * an arbitrary parsed value becomes a valid `AppSettings`.
 *
 * Pure — no module state, no database, no filesystem. That is what lets the
 * field-by-field defenses be read and tested without the store around them.
 */
import type { DshEntry } from '../dsh/dsh.ts'
import type { DevPlugin, LaunchOptions, MarketSource, McpLibEntry, RunMode } from '../../../shared/types.ts'

/** One npm registry a machine points at.
 *
 * `scopes` is what makes several of these coexist: an entry owns the package
 * scopes it lists and nothing else, so "which registry answers for this package"
 * has exactly one answer - the scope match, or the public registry. A registry
 * with no scope owns nothing and takes part in no lookup. */
export interface RegistryEntryRecord {
  /** Stable identity. Referenced by the download page's source choice and by the
   * token, so it survives a URL edit. */
  id: string
  /** What the settings list shows. Derived from the host when first added. */
  label: string
  /** Registry base, normalized (no trailing slash). */
  url: string
  /** The package scopes this registry owns (`['@a', '@b']`). One artifact
   * repository often holds several; a package outside all of them is not this
   * registry's, and resolves from the public one. */
  scopes?: string[]
  /** Mirror mode: this registry proxies npm, so it answers for every package no
   * scope claims. Opt-in and exclusive - at most one entry may set it, and it
   * cannot also list scopes (a scope it ignored would be a silent surprise). */
  catchAll?: boolean
  /** Encrypted token for this registry. A secret: stripped from every export. */
  tokenEnc?: string
}

/** One user-configured market catalog (a `plugins.json` somewhere).
 *
 * The public catalog is NOT in this list: it is built in, always available and
 * not editable, so the list only ever holds catalogs the user added. */
export interface MarketCatalogRecord {
  /** Stable identity. The token hangs off this, so it survives a URL edit. */
  id: string
  /** What the market's picker shows. Unique, case-insensitively. */
  name: string
  /** The `plugins.json` address. */
  url: string
  /** Token for this catalog, encrypted at rest. A secret: stripped from exports. */
  tokenEnc?: string
}

/** The merged settings shape callers see (a union of the three stored rows). */
export interface AppSettings {  /** Single launcher data root. When set, the three launcher-owned directories
   * derive from it — `<dataRoot>/plugins`, `<dataRoot>/skill-library`,
   * `<dataRoot>/dsh/versions` — and `pluginDir` / `dshVersionDir` no longer
   * apply. Unset falls back to the Electron `userData` dir, which is the
   * layout every build before this field used. Never covers profiles: those
   * stay at `<home>/profiles` (see docs/specs/profile.md P5). */
  dataRoot?: string
  /** Directory where downloaded/installed plugins are kept. Superseded by
   * `dataRoot` when that is set; retained as the pre-`dataRoot` value so a
   * cleared root restores it and a migration still knows the old location. */
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
  /** The market catalogs this machine knows about. The public one is implicit. */
  marketCatalogs?: MarketCatalogRecord[]
  /** Which catalog the market shows. Absent = the public one. */
  marketActiveId?: string
  /** @deprecated Replaced by `marketCatalogs` in the v5 -> v6 migration. */
  marketSource?: MarketSource
  /** Custom market catalog URL, used when `marketSource === 'custom'`. */
  marketUrl?: string
  /** Token for a private catalog. A secret: never exported, never logged. Only
   * ever sent to the configured catalog URL, so it cannot leak to the official one. */
  marketTokenEnc?: string
  /** The npm registries this machine points at.
   *
   * **At most one entry may omit `scope`.** An unscoped registry answers for
   * every package no scope claims, so two of them would be two different answers
   * to the same question — the writer (the settings IPC) refuses that, and the
   * router relies on it.
   *
   * Order is presentation order; routing never depends on it (a scope is matched
   * by name, and the fallback is found by its absence of one). */
  registries?: RegistryEntryRecord[]
  /** @deprecated Renamed into `registries` by the v3 → v4 migration. Read so an
   * old row or an old export still migrates; never written by this build. */
  registryUrl?: string
  /** @deprecated — see `registryUrl`. */
  registryScope?: string
  /** @deprecated — see `registryUrl`. A secret. */
  registryTokenEnc?: string
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
  'dataRoot' | 'pluginDir' | 'dshVersionDir' | 'uiLanguage' | 'closeToTray' | 'askOnClose' |
  'nodePreference' | 'onboarded' | 'marketCatalogs' | 'marketActiveId' | 'marketSource' | 'marketUrl' | 'marketTokenEnc' | 'registries' |
  'registryUrl' | 'registryScope' | 'registryTokenEnc' | 'githubTokenEnc' |
  'mcpSecrets' | 'mcpLibrary' | 'devPlugins'>
/** The `dsh` row: the registered dsh installs. */
export type DshSettings = Pick<AppSettings, 'dshes'>
/** The `launch` row: per-profile launch config. */
export type LaunchSettings = Pick<AppSettings, 'launchOptions' | 'runModes'>

/** Current on-disk schema version. Bump when a migration is added. */
export const CURRENT_SCHEMA_VERSION = 6

type Migration = (s: AppSettings) => AppSettings
/** Ordered migrations keyed by the version they upgrade FROM (`v → v+1`).
 * 0 → 1 is the storage split, handled structurally, so no data-shape step.
 * 1 → 2 adds the optional `dataRoot` field — purely additive, so there is no
 * step either; the bump exists so `importSettings` refuses a newer export
 * instead of silently dropping the root on an older build.
 * 2 → 3 adds the optional `registryUrl` — same reasoning, no step.
 *
 * 3 → 4 is the first step with real data movement: the single
 * `registryUrl` / `registryScope` / `registryTokenEnc` triple becomes the first
 * member of `registries`. A machine that configured one registry keeps exactly
 * that one, with the same scope and the same (encrypted) token, so an upgrade
 * cannot lose a credential or start resolving from somewhere else. */
const MIGRATIONS: Record<number, Migration> = {
  3: (s) => {
    if (s.registries !== undefined) return s
    const url = typeof s.registryUrl === 'string' ? s.registryUrl.trim().replace(/\/+$/, '') : ''
    const { registryUrl: _url, registryScope: _scope, registryTokenEnc: _token, ...rest } = s
    if (url === '') return rest
    const scope = typeof s.registryScope === 'string' ? s.registryScope.trim() : ''
    return {
      ...rest,
      registries: [{
        id: 'default',
        label: hostLabel(url),
        url,
        ...(scope !== '' ? { scopes: [scope.startsWith('@') ? scope : `@${scope}`] } : {}),
        ...(typeof s.registryTokenEnc === 'string' && s.registryTokenEnc !== ''
          ? { tokenEnc: s.registryTokenEnc }
          : {}),
      }],
    }
  },
  4: (s) => {
    // `scope` became `scopes`: one artifact repository can hold several package
    // scopes, and a single value could only ever describe one of them.
    if (s.registries === undefined) return s
    return {
      ...s,
      registries: s.registries.map((entry) => {
        const legacy = entry as RegistryEntryRecord & { scope?: string }
        const { scope, ...rest } = legacy
        return {
          ...rest,
          ...(typeof scope === 'string' && scope !== '' ? { scopes: [scope] } : {}),
        }
      }),
    }
  },
  5: (s) => {
    // One custom catalog became a named list. The single URL keeps its token and
    // becomes the active entry, so an upgrade does not lose a credential or start
    // showing a different catalog.
    const url = typeof s.marketUrl === 'string' ? s.marketUrl.trim() : ''
    const { marketSource: _source, marketUrl: _url, marketTokenEnc: _token, ...rest } = s
    if (url === '') return rest
    const id = 'market-1'
    return {
      ...rest,
      marketCatalogs: [{
        id,
        name: hostLabel(url),
        url,
        ...(typeof s.marketTokenEnc === 'string' && s.marketTokenEnc !== '' ? { tokenEnc: s.marketTokenEnc } : {}),
      }],
      marketActiveId: id,
    }
  },
}

/** A URL's host, for the label a migrated entry gets. Falls back to the raw text
 * so a hand-edited value still shows as something recognisable. */
function hostLabel(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function splitPrefs(s: AppSettings): PrefsSettings {
  return {
    ...(s.dataRoot !== undefined ? { dataRoot: s.dataRoot } : {}),
    ...(s.pluginDir !== undefined ? { pluginDir: s.pluginDir } : {}),
    ...(s.dshVersionDir !== undefined ? { dshVersionDir: s.dshVersionDir } : {}),
    ...(s.uiLanguage !== undefined ? { uiLanguage: s.uiLanguage } : {}),
    ...(s.closeToTray !== undefined ? { closeToTray: s.closeToTray } : {}),
    ...(s.askOnClose !== undefined ? { askOnClose: s.askOnClose } : {}),
    ...(s.nodePreference !== undefined ? { nodePreference: s.nodePreference } : {}),
    ...(s.onboarded !== undefined ? { onboarded: s.onboarded } : {}),
    ...(s.marketCatalogs !== undefined ? { marketCatalogs: s.marketCatalogs } : {}),
    ...(s.marketActiveId !== undefined ? { marketActiveId: s.marketActiveId } : {}),
    ...(s.marketSource !== undefined ? { marketSource: s.marketSource } : {}),
    ...(s.marketUrl !== undefined ? { marketUrl: s.marketUrl } : {}),
    ...(s.marketTokenEnc !== undefined ? { marketTokenEnc: s.marketTokenEnc } : {}),
    ...(s.registries !== undefined ? { registries: s.registries } : {}),
    ...(s.registryUrl !== undefined ? { registryUrl: s.registryUrl } : {}),
    ...(s.registryScope !== undefined ? { registryScope: s.registryScope } : {}),
    ...(s.registryTokenEnc !== undefined ? { registryTokenEnc: s.registryTokenEnc } : {}),
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

/** Normalize the registry list: an entry needs an id and a URL; every scope is
 * coerced to `@name` form; a token is kept verbatim (it is opaque at rest).
 * Entries sharing an id are dropped after the first, and a scope already claimed
 * by another entry is dropped from this one, because routing has to have ONE
 * answer per package. */
function readRegistries(raw: unknown[]): RegistryEntryRecord[] {
  const out: RegistryEntryRecord[] = []
  const ids = new Set<string>()
  const claimed = new Set<string>()
  for (const item of raw) {
    if (!isRecord(item)) continue
    const id = typeof item.id === "string" ? item.id.trim() : ""
    const url = typeof item.url === "string" ? item.url.trim().replace(/\/+$/, "") : ""
    if (id === "" || url === "" || ids.has(id)) continue
    // `scopes` is the current shape; `scope` is what a v4 row carries.
    const rawScopes: unknown[] = Array.isArray(item.scopes)
      ? item.scopes
      : (typeof item.scope === "string" ? [item.scope] : [])
    const catchAll = item.catchAll === true
    const scopes: string[] = []
    for (const value of rawScopes) {
      if (typeof value !== "string") continue
      const trimmed = value.trim()
      if (trimmed === "") continue
      const scope = trimmed.startsWith("@") ? trimmed : `@${trimmed}`
      const key = scope.toLowerCase()
      if (claimed.has(key) || scopes.some(s => s.toLowerCase() === key)) continue
      scopes.push(scope)
    }
    ids.add(id)
    for (const scope of scopes) claimed.add(scope.toLowerCase())
    const label = typeof item.label === "string" && item.label.trim() !== "" ? item.label.trim() : hostLabel(url)
    out.push({
      id,
      label,
      url,
      ...(scopes.length > 0 && catchAll !== true ? { scopes } : {}),
      ...(catchAll === true ? { catchAll: true } : {}),
      ...(typeof item.tokenEnc === "string" && item.tokenEnc !== "" ? { tokenEnc: item.tokenEnc } : {}),
    })
  }
  return out
}

/** Normalize the market catalog list: an entry needs an id and a URL, names are
 * unique case-insensitively (the picker shows names, so two alike are one too
 * many). An unusable entry is dropped rather than shown as a broken row. */
function readMarketCatalogs(raw: unknown[]): MarketCatalogRecord[] {
  const out: MarketCatalogRecord[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const item of raw) {
    if (!isRecord(item)) continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const url = typeof item.url === 'string' ? item.url.trim() : ''
    if (id === '' || url === '' || ids.has(id)) continue
    const name = typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim() : hostLabel(url)
    if (names.has(name.toLowerCase())) continue
    ids.add(id)
    names.add(name.toLowerCase())
    out.push({
      id,
      name,
      url,
      ...(typeof item.tokenEnc === 'string' && item.tokenEnc !== '' ? { tokenEnc: item.tokenEnc } : {}),
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

  const dataRoot = nonEmptyString(raw.dataRoot)
  if (dataRoot !== undefined) out.dataRoot = dataRoot
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
  const marketTokenEnc = nonEmptyString(raw.marketTokenEnc)
  if (marketTokenEnc !== undefined) out.marketTokenEnc = marketTokenEnc
  if (Array.isArray(raw.marketCatalogs)) {
    const catalogs = readMarketCatalogs(raw.marketCatalogs)
    if (catalogs.length > 0) out.marketCatalogs = catalogs
  }
  const marketActiveId = nonEmptyString(raw.marketActiveId)
  if (marketActiveId !== undefined) out.marketActiveId = marketActiveId
  const marketUrl = nonEmptyString(raw.marketUrl)
  if (marketUrl !== undefined) out.marketUrl = marketUrl
  const registryUrl = nonEmptyString(raw.registryUrl)
  if (registryUrl !== undefined) out.registryUrl = registryUrl
  const registryScope = nonEmptyString(raw.registryScope)
  if (registryScope !== undefined) out.registryScope = registryScope
  const registryTokenEnc = nonEmptyString(raw.registryTokenEnc)
  if (registryTokenEnc !== undefined) out.registryTokenEnc = registryTokenEnc
  if (Array.isArray(raw.registries)) {
    const registries = readRegistries(raw.registries)
    if (registries.length > 0) out.registries = registries
  }
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
