/**
 * Registry credentials: at rest, and in the shape a request needs them.
 *
 * One token **per entry**, because a machine can point at several registries and
 * a credential belongs to one of them. The value never leaves this module; the
 * renderer gets `RegistryEntryView` (label, url, scope, and whether a token
 * exists), never the token.
 *
 * Same envelope as the GitHub token and the MCP launch secrets
 * (`settings/secret-at-rest.ts`): encrypted when the OS keyring is available,
 * marked plaintext when it is not — and said out loud rather than implied.
 *
 * Two consumers:
 * - `registryAuthHeader` — the launcher's own `fetch` calls;
 * - the pnpm child environment, where each token travels as
 *   `PM_REGISTRY_TOKEN_<ID>` and the generated `.npmrc` refers to it by name
 *   (`store/registry-config.ts`).
 */
import { updateSettings } from '../settings/settings.ts'
import { createSecretCodec, type SecretCipher } from '../settings/secret-at-rest.ts'
import { logger } from '../shared/logger.ts'
import { normalizeScope } from './npmrc.ts'
import { registries, registryEntries } from './registry.ts'
import type { PrivateSource } from './npmrc.ts'
import type { RegistryEntryRecord } from '../settings/normalize.ts'
import type { RegistryEntryView } from '../../../shared/types.ts'

/** The variable name one entry's token travels under. Derived from the id so
 * several registries can be configured without sharing a variable. */
export function registryTokenEnvName(id: string): string {
  return `PM_REGISTRY_TOKEN_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

/** The tokens' at-rest envelope. One codec, one label — the value is the same
 * kind of secret for every entry. */
const codec = createSecretCodec('registry token')

/** Decoded tokens keyed by the stored envelope, so unchanged entries are not
 * re-decrypted on every package lookup. */
const cache = new Map<string, string | undefined>()

/** Inject the at-rest cipher (main process wires safeStorage; tests inject a fake). */
export function setRegistryTokenCipher(next: SecretCipher | null): void {
  codec.setCipher(next)
  cache.clear()
}

/** The plaintext token for one entry, or `undefined` when none is saved or it
 * cannot be decrypted (a keyring change, or settings imported from elsewhere). */
export function registryTokenOf(entry: RegistryEntryRecord): string | undefined {
  const stored = entry.tokenEnc
  if (typeof stored !== 'string' || stored === '') return undefined
  if (cache.has(stored)) return cache.get(stored)
  const plain = codec.decode(stored)
  cache.set(stored, plain)
  return plain
}

/** Every entry as the renderer may see it: no token value, only whether one
 * exists and how it is protected. */
export function registryEntryViews(): RegistryEntryView[] {
  return registryEntries().map((entry) => {
    const hasToken = registryTokenOf(entry) !== undefined
    return {
      id: entry.id,
      label: entry.label,
      url: entry.url,
      scopes: entry.scopes ?? [],
      hasToken,
      encryption: hasToken ? (codec.available() ? 'safe' : 'plaintext') : 'none',
    }
  })
}

/** Save (or clear, with `''`/`null`) one entry's token. Never logs the value. */
export function setRegistryToken(id: string, value: string | null): RegistryEntryView[] {
  const plain = value?.trim() ?? ''
  updateSettings((draft) => {
    const list = draft.registries
    if (list === undefined) return
    const entry = list.find(e => e.id === id)
    if (entry === undefined) return
    if (plain === '') delete entry.tokenEnc
    else entry.tokenEnc = codec.encode(plain)
  })
  cache.clear()
  logger.info(`registry: token ${plain === '' ? 'cleared' : 'saved'} for "${id}"`)
  return registryEntryViews()
}

/** The configured registries as npm has to be told about them — one per entry,
 * each naming its own token variable when it has a token. Invalid URLs are
 * already filtered out by `registries()`, so nothing here can build a bad file. */
export function privateSources(): PrivateSource[] {
  // Only scoped entries: a source with no scope owns nothing, so it must not
  // appear in pnpm's configuration either — pnpm and the launcher have to agree.
  const out: PrivateSource[] = []
  for (const entry of registries()) {
    const tokenEnv = registryTokenOf(entry) !== undefined ? registryTokenEnvName(entry.id) : undefined
    for (const scope of entry.scopes ?? []) {
      out.push({
        registry: entry.url,
        scope,
        ...(tokenEnv !== undefined ? { tokenEnv } : {}),
      })
    }
  }
  return out
}


/** Every token as environment entries, for the pnpm child. Unscoped entries are
 * left out for the same reason they are left out of the file. */
export function registryTokenEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of registries()) {
    if ((entry.scopes ?? []).length === 0) continue
    const token = registryTokenOf(entry)
    if (token !== undefined) env[registryTokenEnvName(entry.id)] = token
  }
  return env
}

/** Trailing slashes off, for comparing a request URL with a registry base. */
function bare(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/**
 * The `Authorization` header for a request to `url`, or `{}` when no configured
 * registry owns that URL (or the owning one has no token).
 *
 * `Bearer` is the only scheme: it is what pnpm puts on the wire for the
 * `_authToken` line in the generated `.npmrc`, so the lookup that decides "which
 * versions exist" authenticates exactly like the install that follows it. The
 * registry protocol's `_authToken` IS a bearer token — a user name and password
 * pair is a different mechanism (`_auth`) and is not guessed at here.
 *
 * Longest match wins: with `https://host/team/repo` and `https://host` both
 * configured, the narrower one owns the request. Attaching a token to a URL no
 * entry owns would hand a private credential to a third party, which is why the
 * guard is a prefix test against the configured bases and not a host test.
 */
export function registryAuthHeader(url: string): Record<string, string> {
  const target = bare(url)
  const owner = registries()
    .map(entry => ({ base: bare(entry.url), token: registryTokenOf(entry) }))
    .filter(c => c.token !== undefined && (target === c.base || target.startsWith(`${c.base}/`)))
    .sort((a, b) => b.base.length - a.base.length)[0]
  return owner?.token !== undefined ? { authorization: `Bearer ${owner.token}` } : {}
}
