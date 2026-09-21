/**
 * The at-rest envelope both secrets share.
 *
 * The behaviour worth locking is the degradation path: with no usable cipher
 * (portable build, locked-down machine) a value is still stored — marked
 * `plain:` so it can be read back — and a value that cannot be decrypted reads
 * as absent rather than throwing into a settings load.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSecretCodec, PLAIN_PREFIX, type SecretCipher } from './secret-at-rest.ts'
import { logger } from '../shared/logger.ts'

/** A cipher that reverses the string, so an encrypted value is recognizable. */
const fakeCipher = (over: Partial<SecretCipher> = {}): SecretCipher => ({
  available: () => true,
  encrypt: plain => `enc:${[...plain].reverse().join('')}`,
  decrypt: cipherText => [...cipherText.replace(/^enc:/, '')].reverse().join(''),
  ...over,
})

describe('createSecretCodec', () => {
  it('round-trips a value through the injected cipher', () => {
    const codec = createSecretCodec('test')
    codec.setCipher(fakeCipher())
    const stored = codec.encode('hunter2')
    expect(stored).toBe('enc:2retnuh')
    expect(codec.decode(stored)).toBe('hunter2')
  })

  it('marks a value plaintext when no cipher was injected', () => {
    const codec = createSecretCodec('test')
    expect(codec.available()).toBe(false)
    expect(codec.encode('hunter2')).toBe(`${PLAIN_PREFIX}hunter2`)
  })

  it('marks a value plaintext when the cipher reports itself unusable', () => {
    const codec = createSecretCodec('test')
    codec.setCipher(fakeCipher({ available: () => false }))
    expect(codec.available()).toBe(false)
    expect(codec.encode('hunter2')).toBe(`${PLAIN_PREFIX}hunter2`)
  })

  it('still reads a plaintext-marked value back without a cipher', () => {
    const codec = createSecretCodec('test')
    expect(codec.decode(`${PLAIN_PREFIX}hunter2`)).toBe('hunter2')
  })

  it('reads an encrypted value as absent when no cipher is available', () => {
    const codec = createSecretCodec('test')
    expect(codec.decode('enc:2retnuh')).toBeUndefined()
  })

  it('reads an undecryptable value as absent, naming the secret in the log', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const codec = createSecretCodec('mcp secrets: saved value for a name')
    codec.setCipher(fakeCipher({ decrypt: () => { throw new Error('keyring changed') } }))
    expect(codec.decode('enc:2retnuh')).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      'mcp secrets: saved value for a name could not be decrypted (keyring changed)',
    )
    warn.mockRestore()
  })
})
