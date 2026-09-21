/**
 * MCP launch secrets: the values behind the `!!js process.env.<NAME>`
 * references the launcher writes into MCP rows.
 *
 * A reference keeps the secret out of `cordis.patch.yml` — and therefore out of
 * a profile export or a backup — but something must still provide the value at
 * launch. That is this store: name → value, encrypted at rest via Electron
 * `safeStorage` (injected as a cipher so this module stays Electron-free and
 * unit-testable) and re-injected into every dsh child's environment by the run
 * path (see `ipc/run.ts`).
 *
 * Values never leave the main process: the renderer only ever sees names, and
 * `exportSettings` strips the whole map, so a backup cannot carry a secret.
 */
import { loadSettings, updateSettings } from './settings.ts'
import { createSecretCodec, type SecretCipher } from './secret-at-rest.ts'
import { logger } from './logger.ts'

/** Encrypt/decrypt a secret at rest; injected by the main process (safeStorage). */
export type McpSecretCipher = SecretCipher

/** An env var name must be a valid `[A-Za-z_][A-Za-z0-9_]*` identifier. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The secrets' at-rest envelope. */
const codec = createSecretCodec('mcp secrets: saved value for a name')

/** Inject the at-rest cipher (main process wires safeStorage; tests inject a fake). */
export function setMcpSecretCipher(next: McpSecretCipher | null): void {
  codec.setCipher(next)
}

/** The stored map, safely defaulted. */
function storedMap(): Record<string, string> {
  return loadSettings().mcpSecrets ?? {}
}

/** Names of the stored secrets, sorted. Values never cross this boundary. */
export function listMcpSecretNames(): string[] {
  return Object.keys(storedMap()).sort()
}

/** Whether a name has a non-empty value stored. */
export function hasMcpSecret(name: string): boolean {
  const stored = storedMap()[name]
  return stored !== undefined && stored !== ''
}

/** Decrypt one stored secret, or `undefined` when absent / undecryptable. */
export function getMcpSecret(name: string): string | undefined {
  const stored = storedMap()[name]
  if (stored === undefined || stored === '') return undefined
  return codec.decode(stored)
}

/** Save (or clear, with `''`/`null`) one launch secret. Only the NAME is ever
 * logged or returned; the value stays in main-process memory + encrypted disk. */
export function setMcpSecret(name: string, value: string | null): void {
  const key = name.trim()
  if (key === '' || !NAME_RE.test(key)) throw new Error(`invalid secret name: ${key || '(empty)'}`)
  const plain = value?.trim() ?? ''
  const wasSet = storedMap()[key] !== undefined
  updateSettings((draft) => {
    const next = { ...(draft.mcpSecrets ?? {}) }
    if (plain === '') delete next[key]
    else next[key] = codec.encode(plain)
    if (Object.keys(next).length === 0) delete draft.mcpSecrets
    else draft.mcpSecrets = next
  })
  const action = plain === '' ? (wasSet ? 'cleared' : 'absent') : (wasSet ? 'updated' : 'saved')
  logger.info(`mcp secrets: ${action} ${key}`)
}

/** Every secret decrypted, for injecting into a dsh child's environment. */
export function mcpSecretsEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const name of listMcpSecretNames()) {
    const value = getMcpSecret(name)
    if (value !== undefined) out[name] = value
  }
  return out
}
