/**
 * GitHub API authentication for update detection.
 *
 * Unauthenticated `api.github.com` allows 60 requests/hour per IP — the plugin
 * update check and the app self-update check can exhaust that, after which
 * github-origin plugins silently fall back to "manual". A personal access token
 * raises the quota to 5000/hour.
 *
 * The token is resolved from, in order: the saved setting (encrypted at rest via
 * Electron `safeStorage`, injected as a {@link TokenCipher} so this module stays
 * Electron-free and unit-testable) and the `GH_TOKEN` / `GITHUB_TOKEN`
 * environment variables.
 *
 * The token is a secret: it is never logged, and `exportSettings` strips it so a
 * settings backup cannot leak it.
 */
import { loadSettings, updateSettings } from '../settings/settings.ts'
import { createSecretCodec, type SecretCipher } from '../settings/secret-at-rest.ts'
import { logger } from '../shared/logger.ts'
import type { GithubAuthState, GithubEncryption, GithubRateLimit, GithubTokenSource } from '../../../shared/types.ts'

/** Encrypt/decrypt a token at rest; injected by the main process (safeStorage).
 * The historical name for the envelope the MCP secrets share (`SecretCipher`). */
export type TokenCipher = SecretCipher

/** Quota probe endpoint — cheap and auth-aware. */
const RATE_LIMIT_URL = 'https://api.github.com/rate_limit'
const USER_URL = 'https://api.github.com/user'
const PROBE_TIMEOUT_MS = 10_000

/** The token's at-rest envelope. */
const codec = createSecretCodec('github auth: saved token')

let token: string | null = null
let source: GithubTokenSource = 'none'
let rateLimited = false

/** Inject the at-rest cipher (main process wires safeStorage; tests inject a fake). */
export function setTokenCipher(next: TokenCipher | null): void {
  codec.setCipher(next)
}

/** The environment token, if any (`GH_TOKEN` wins over `GITHUB_TOKEN`; a
 * present-but-blank variable is treated as unset). */
function envToken(): string | undefined {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[name]?.trim()
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

function encryptionMode(): GithubEncryption {
  if (token === null || source !== 'settings') return 'none'
  return codec.available() ? 'safe' : 'plaintext'
}

/** Resolve the effective token: saved setting first, then the environment. Call
 * once at startup, after the settings DB is open. */
export function initGithubAuth(): GithubAuthState {
  const stored = loadSettings().githubTokenEnc
  const saved = typeof stored === 'string' && stored !== '' ? codec.decode(stored) : undefined
  if (saved !== undefined) {
    token = saved
    source = 'settings'
  } else {
    const fromEnv = envToken()
    token = fromEnv ?? null
    source = fromEnv === undefined ? 'none' : 'env'
  }
  logger.info(`github auth: ${source === 'none' ? 'unauthenticated (60 req/h)' : `token from ${source} (5000 req/h)`}`)
  return githubAuthState()
}

/** Save (or clear, with `''`/`null`) the user's token. Returns the new state. */
export function setGithubToken(value: string | null): GithubAuthState {
  const plain = value?.trim() ?? ''
  if (plain === '') {
    updateSettings((draft) => { delete draft.githubTokenEnc })
    const fromEnv = envToken()
    token = fromEnv ?? null
    source = fromEnv === undefined ? 'none' : 'env'
  } else {
    const stored = codec.encode(plain)
    updateSettings((draft) => { draft.githubTokenEnc = stored })
    token = plain
    source = 'settings'
  }
  rateLimited = false
  // Never log the token itself — only that it changed and where it now comes from.
  logger.info(`github auth: token ${plain === '' ? 'cleared' : 'saved'} (source=${source})`)
  return githubAuthState()
}

/** Request headers for `api.github.com`, adding `Authorization` when a token is
 * in effect. HTTP header names are case-insensitive. */
export function githubAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-launcher',
    ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  }
}

/** Record whether a GitHub response was rate-limited (403/429 with no quota
 * left), so the UI can explain why github-origin plugins fell back to "manual". */
export function noteGithubResponse(res: { status: number; headers: { get(name: string): string | null } }): boolean {
  const limited = (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0'
  if (limited) rateLimited = true
  return limited
}

/** Clear the sticky rate-limit flag (a fresh check starts clean). */
export function resetGithubRateLimit(): void {
  rateLimited = false
}

/** The current authentication + rate-limit state. */
export function githubAuthState(): GithubAuthState {
  return { authenticated: token !== null, source, encryption: encryptionMode(), rateLimited }
}

async function fetchLogin(): Promise<string | undefined> {
  try {
    const res = await fetch(USER_URL, { headers: githubAuthHeaders(), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!res.ok) return undefined
    const body = await res.json() as { login?: unknown }
    return typeof body.login === 'string' ? body.login : undefined
  } catch {
    return undefined
  }
}

/** Probe the live rate limit with the current token (Settings "test" button). */
export async function probeGithubRateLimit(): Promise<GithubRateLimit> {
  try {
    const res = await fetch(RATE_LIMIT_URL, { headers: githubAuthHeaders(), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!res.ok) return { ok: false, limit: 0, remaining: 0 }
    const body = await res.json() as {
      resources?: { core?: { limit?: unknown; remaining?: unknown; reset?: unknown } }
    }
    const core = body.resources?.core ?? {}
    const limit = typeof core.limit === 'number' ? core.limit : 0
    const remaining = typeof core.remaining === 'number' ? core.remaining : 0
    const resetAt = typeof core.reset === 'number' ? new Date(core.reset * 1000).toISOString() : undefined
    const login = token !== null ? await fetchLogin() : undefined
    return {
      ok: true,
      ...(login !== undefined ? { login } : {}),
      limit,
      remaining,
      ...(resetAt !== undefined ? { resetAt } : {}),
    }
  } catch {
    return { ok: false, limit: 0, remaining: 0 }
  }
}
