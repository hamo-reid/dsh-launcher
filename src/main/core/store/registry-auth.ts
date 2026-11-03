/**
 * The private registry's credential: at rest, and in the shape an HTTP request
 * needs it.
 *
 * Same envelope as the GitHub token and the MCP launch secrets
 * (`settings/secret-at-rest.ts`): encrypted when the OS keyring is available,
 * marked plaintext when it is not, and never logged, exported, or rendered.
 *
 * The *value* never leaves this module. Two places consume it:
 * - `registryAuthHeader` — the launcher's own `fetch` calls (version lookup),
 *   which would otherwise get a 403 from a private registry and report "package
 *   not found";
 * - the pnpm child environment, where it is supplied as an environment variable
 *   that the generated `.npmrc` refers to by name (`store/registry-config.ts`).
 */
import { loadSettings, updateSettings } from '../settings/settings.ts'
import { createSecretCodec, type SecretCipher } from '../settings/secret-at-rest.ts'
import { logger } from '../shared/logger.ts'
import { normalizeScope } from './npmrc.ts'
import type { PrivateSource } from './npmrc.ts'
import type { RegistryAuthState } from '../../../shared/types.ts'

/** The variable the generated `.npmrc` refers to. One name is enough: the token
 * authorizes exactly one registry — the configured one. */
export const REGISTRY_TOKEN_ENV = 'PM_REGISTRY_TOKEN'

/** The token's at-rest envelope. */
const codec = createSecretCodec('private registry')

/** Last decoded value, keyed by the stored envelope, so a settings change (or an
 * import) is picked up without every caller paying for a decrypt. */
let cache: { stored: string; plain: string | undefined } | null = null

/** Inject the at-rest cipher (main process wires safeStorage; tests inject a fake). */
export function setRegistryTokenCipher(next: SecretCipher | null): void {
  codec.setCipher(next)
  cache = null
}

/** The plaintext token, or `undefined` when none is configured / it cannot be
 * decrypted (a keyring change, or settings imported from another machine). */
export function registryToken(): string | undefined {
  const stored = loadSettings().registryTokenEnc
  if (typeof stored !== 'string' || stored === '') return undefined
  if (cache?.stored === stored) return cache.plain
  const plain = codec.decode(stored)
  cache = { stored, plain }
  return plain
}

/** Save (or clear, with `''`/`null`) the token. Never logs the value. */
export function setRegistryToken(value: string | null): RegistryAuthState {
  const plain = value?.trim() ?? ''
  updateSettings((draft) => {
    if (plain === '') delete draft.registryTokenEnc
    else draft.registryTokenEnc = codec.encode(plain)
  })
  cache = null
  logger.info(`private registry: token ${plain === '' ? 'cleared' : 'saved'}${plain !== '' && !codec.available() ? ' (no OS keyring — stored as plaintext)' : ''}`)
  return registryAuthState()
}

/** What the renderer is allowed to know: whether a token exists and how it is
 * protected. The value itself never crosses. */
export type { RegistryAuthState }

export function registryAuthState(): RegistryAuthState {
  const configured = registryToken() !== undefined
  if (!configured) return { configured: false, encryption: 'none' }
  return { configured: true, encryption: codec.available() ? 'safe' : 'plaintext' }
}

/** The private source as npm has to be told about it, or `undefined` when the
 * configured registry needs no credential (nothing to inject). */
export function privateRegistrySource(): PrivateSource | undefined {
  const url = loadSettings().registryUrl
  if (typeof url !== 'string' || url.trim() === '') return undefined
  const token = registryToken()
  const scope = normalizeScope(loadSettings().registryScope)
  return {
    registry: url,
    ...(scope !== undefined ? { scope } : {}),
    // No token means no auth line: a public mirror needs none, and an auth line
    // pointing at an unset variable would fail every install with a 401.
    ...(token !== undefined ? { tokenEnv: REGISTRY_TOKEN_ENV } : {}),
  }
}

/** Trimmed, slash-free form used to compare a request URL against the configured
 * registry. */
function bare(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/**
 * The `Authorization` header for a request to `url`, or `{}` when the request is
 * not for the configured registry (or no token is saved).
 *
 * `Bearer` is the only scheme: it is what pnpm puts on the wire for the
 * `_authToken` line in the generated `.npmrc`, so the lookup that decides "which
 * versions exist" authenticates exactly like the install that follows it. The
 * registry protocol's `_authToken` is a bearer token — a user name and password
 * pair is a different mechanism (`_auth`), and inventing one here meant guessing
 * a user name on the caller's behalf.
 *
 * Only the configured registry gets it: the routing in `store/registry.ts` sends
 * every other package to the public registry, and attaching the credential there
 * would hand a private token to a third party.
 */
export function registryAuthHeader(url: string): Record<string, string> {
  const token = registryToken()
  if (token === undefined) return {}
  const base = bare(loadSettings().registryUrl ?? '')
  if (base === '') return {}
  const target = bare(url)
  if (target !== base && !target.startsWith(`${base}/`)) return {}
  return { authorization: `Bearer ${token}` }
}
