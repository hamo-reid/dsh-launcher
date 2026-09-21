/**
 * The at-rest envelope shared by the launcher's two secrets — the GitHub token
 * (`github-auth.ts`) and the MCP launch secrets (`mcp-secrets.ts`).
 *
 * Both hold a value that must round-trip through settings without leaving
 * plaintext on disk, and both fall back to a marked-plaintext prefix when the OS
 * keyring is unavailable (a portable build on a locked-down machine). The cipher
 * is injected — the main process wires Electron `safeStorage`, tests inject a
 * fake — so this module stays Electron-free and unit-testable.
 */
import { logger } from './logger.ts'

/** Encrypt/decrypt a secret at rest; injected by the main process (safeStorage). */
export interface SecretCipher {
  available(): boolean
  encrypt(plain: string): string
  decrypt(cipherText: string): string
}

/** Prefix marking a value stored without OS encryption (no keyring available). */
export const PLAIN_PREFIX = 'plain:'

/** One secret's at-rest codec. */
export interface SecretCodec {
  /** Inject the cipher (main process wires safeStorage; tests inject a fake). */
  setCipher(next: SecretCipher | null): void
  /** Whether a cipher is usable right now — i.e. new values get encrypted. */
  available(): boolean
  /** Encrypt for storage, or mark as plaintext when no cipher is available. */
  encode(plain: string): string
  /** Decrypt a stored value, or `undefined` when absent / undecryptable. */
  decode(stored: string): string | undefined
}

/**
 * Build one secret's codec. `label` names the secret in the warning logged when
 * a stored value cannot be decrypted (the keyring changed, or settings were
 * imported from another machine), keeping the two callers distinguishable.
 */
export function createSecretCodec(label: string): SecretCodec {
  let cipher: SecretCipher | null = null
  return {
    setCipher: (next) => { cipher = next },
    available: () => cipher !== null && cipher.available(),
    encode: (plain) => (cipher !== null && cipher.available() ? cipher.encrypt(plain) : `${PLAIN_PREFIX}${plain}`),
    decode: (stored) => {
      if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length)
      if (cipher === null || !cipher.available()) return undefined
      try {
        return cipher.decrypt(stored)
      } catch (error) {
        logger.warn(`${label} could not be decrypted (${error instanceof Error ? error.message : String(error)})`)
        return undefined
      }
    },
  }
}
