/**
 * The npm configuration a private registry needs — as file text, and as the
 * child environment that points pnpm at it.
 *
 * Pure: no settings, no filesystem, no process. The callers own all three, which
 * is what lets the rules below be read and tested without a database or a live
 * registry.
 *
 * The token is deliberately absent from every value here. `buildNpmrc` writes
 * only the *name* of an environment variable (`_authToken=${NAME}`) and
 * `registryEnv` supplies its value to the child process, so a token never has to
 * be written into a file that lives in the plugin store, gets copied with an
 * archive, or lands in a backup.
 *
 * Two shapes of deployment, one code path:
 * - **No scope** — every package resolves against the private source. For an
 *   internal registry that also proxies the public one.
 * - **With a scope** — only `@scope/*` goes to the private source and everything
 *   else keeps resolving from the public registry. For a registry that holds
 *   your own packages and nothing else.
 */

/** The private source, in the shape npm has to be told about it. */
export interface PrivateSource {
  /** Registry base, already normalized (`parseRegistry`). No trailing slash. */
  registry: string
  /** `@myorg` — when set, only that scope is redirected here. */
  scope?: string
  /** Environment variable name carrying the token, e.g. `PM_REGISTRY_TOKEN`.
   * Absent means the source needs no authentication. */
  tokenEnv?: string
}

/** A package name that carries an npm scope (`@scope/name` → `@scope`). */
const SCOPED_NAME = /^(@[^/\s]+)\//

/** The characters npm allows in a scope, after the `@`. */
const SCOPE_BODY = /^[A-Za-z0-9._~-]+$/

/** A name a child process can carry (`process.env` keys are case-sensitive on
 * POSIX; the shape is deliberately conservative). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Normalize a typed registry URL, or `undefined` when it cannot be used.
 *
 * Trailing slashes are dropped so one value has one spelling (npm's own
 * resolution appends `/package`), and a non-HTTP scheme is refused rather than
 * handed to `fetch` — a deployment that asked for a mirror must not silently
 * get a request to nowhere.
 */
export function parseRegistry(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim() ?? ''
  if (trimmed === '') return undefined
  const bare = trimmed.replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(bare)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  return bare
}

/**
 * Normalize a typed scope to `@name`, or `undefined` when it names nothing.
 *
 * Accepts the value with or without the `@` because the two spellings mean the
 * same thing to a person, and refuses anything that could not be half of a
 * package name. The case is preserved (registries may host an uppercase org) but
 * comparisons are case-insensitive — see `matchesScope`.
 */
export function normalizeScope(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim() ?? ''
  if (trimmed === '') return undefined
  const body = trimmed.replace(/^@/, '')
  if (body === '' || !SCOPE_BODY.test(body)) return undefined
  return `@${body}`
}

/** The scope a package name belongs to, or `undefined` for an unscoped name. */
export function scopeOfName(name: string): string | undefined {
  return SCOPED_NAME.exec(name.trim())?.[1]
}

/** Whether a package name belongs to `scope` (case-insensitive, scope normalized). */
export function matchesScope(name: string, scope: string): boolean {
  const own = scopeOfName(name)?.toLowerCase()
  const wanted = normalizeScope(scope)?.toLowerCase()
  return own !== undefined && own === wanted
}

/**
 * The key npm needs to scope a token to one registry: the URL's
 * `//host[:port]/path/`, path included and always ending in `/`.
 *
 * The path is what keeps the token from being offered to every other repository
 * on the same host — a registry mounted under a path prefix (an artifact
 * repository at `/<org>/<repo>/-/packages/`, say) would otherwise be authorized
 * for the whole domain.
 */
export function authKeyFor(registry: string): string | undefined {
  let url: URL
  try {
    url = new URL(registry)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  return `//${url.host}${path}`
}

/**
 * The `.npmrc` text for the configured registries, or `undefined` when one of
 * them cannot be described honestly.
 *
 * The whole table is written at once, because pnpm has to agree with the
 * launcher's routing: one entry supplies the default (`registry=`) and each
 * scoped entry pins its own scope. Writing a partial file — say, only the entry
 * that happens to have a token — would install from a registry the launcher
 * never routed to.
 *
 * `defaultRegistry` is what `registry=` gets when no unscoped entry exists
 * (normally the public registry). Pinning it explicitly keeps the file from
 * inheriting whatever the machine happens to be configured for.
 *
 * Refuses (returns `undefined`) when a token is expected but the registry cannot
 * produce an auth key: an `.npmrc` that claims to authenticate and cannot would
 * turn a configuration mistake into a 401 that looks like a bad token.
 */
export function buildNpmrc(
  sources: readonly PrivateSource[], opts: { defaultRegistry: string },
): string | undefined {
  const parsed: { registry: string; scope?: string; tokenEnv?: string }[] = []
  for (const source of sources) {
    const registry = parseRegistry(source.registry)
    if (registry === undefined) return undefined
    const scope = normalizeScope(source.scope)
    const tokenEnv = source.tokenEnv ?? ''
    // A token that cannot be described — no usable auth key, or a name the child
    // environment could not carry — is a configuration mistake, not a reason to
    // emit the file without the auth line.
    if (tokenEnv !== '' && (authKeyFor(registry) === undefined || !ENV_NAME.test(tokenEnv))) return undefined
    parsed.push({ registry, ...(scope !== undefined ? { scope } : {}), ...(tokenEnv !== '' ? { tokenEnv } : {}) })
  }

  const unscoped = parsed.filter(source => source.scope === undefined)
  // Two unscoped entries answer the same question differently. The settings
  // writer refuses that; refusing here keeps a hand-edited row from producing a
  // file whose meaning depends on line order.
  if (unscoped.length > 1) return undefined

  const lines = [`registry=${unscoped[0]?.registry ?? opts.defaultRegistry}`]
  for (const source of parsed) {
    if (source.scope !== undefined) lines.push(`${source.scope}:registry=${source.registry}`)
  }
  let anyToken = false
  for (const source of parsed) {
    const tokenEnv = source.tokenEnv ?? ''
    if (tokenEnv === '') continue
    const authKey = authKeyFor(source.registry)
    if (authKey === undefined) return undefined
    // The value is supplied by `registryEnv`; `${NAME}` is the one form that
    // keeps the secret out of every copy of this file.
    lines.push(`${authKey}:_authToken=\${${tokenEnv}}`)
    anyToken = true
  }
  if (anyToken) lines.push('always-auth=true')
  return `${lines.join('\n')}\n`
}

/**
 * The environment additions that make the file above take effect: pnpm reads the
 * user config from `NPM_CONFIG_USERCONFIG`, and each token travels as its own
 * variable so the file never holds one.
 *
 * Returns only the keys it owns — the caller spreads them over the environment
 * it already builds, so a value it set for another reason is not overwritten by
 * an empty one here. A missing token means no variable, never an empty one: a
 * stale value must not authorize a request the current settings do not.
 */
export function registryEnv(input: {
  configPath: string
  tokens?: Readonly<Record<string, string>>
}): Record<string, string> {
  const env: Record<string, string> = { NPM_CONFIG_USERCONFIG: input.configPath }
  for (const [name, value] of Object.entries(input.tokens ?? {})) {
    if (ENV_NAME.test(name) && value !== '') env[name] = value
  }
  return env
}
