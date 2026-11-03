/**
 * The registry URL boundary.
 *
 * A configured value becomes request URLs, so an unusable one is refused HERE
 * rather than warned about at the first search — and the refusal has to say which
 * value was refused. It used to return `name.invalid`, whose localized message is
 * "invalid name": `apiErrorText` prefers the message, so the one useful part of
 * the answer (the URL) never reached the user.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, loadSettings } from '../../core/settings/settings.ts'
import { registerSettingsIpc } from './settings.ts'
import type { IpcResult } from '../../../shared/types.ts'

const channels = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => '' },
  dialog: {},
  shell: { openPath: vi.fn(async () => '') },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void => {
      channels.set(channel, fn)
    },
  },
}))

let root: string

async function call<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  const fn = channels.get(channel)
  if (fn === undefined) throw new Error(`${channel} was not registered`)
  return await fn({}, ...args) as IpcResult<T>
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-settings-ipc-'))
  await openDatabase(join(root, 'app.sqlite'))
  registerSettingsIpc()
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('settings:setRegistryUrl', () => {
  it('refuses an unparseable value with its own code AND the offending text', async () => {
    const r = await call<string | null>('settings:setRegistryUrl', 'not a url')
    expect(r).toMatchObject({ ok: false, code: 'registry.badUrl', params: { detail: 'not a url' } })
    // The URL survives in the params, which is what the localized message
    // interpolates — the point of not reusing `name.invalid`.
    expect(r.ok === false && r.params).toEqual({ detail: 'not a url' })
  })

  it('refuses a non-http(s) scheme the same way', async () => {
    expect(await call('settings:setRegistryUrl', 'ftp://mirror.example'))
      .toMatchObject({ ok: false, code: 'registry.badScheme', params: { detail: 'ftp://mirror.example' } })
  })

  it('still accepts a mirror URL, normalized', async () => {
    const r = await call<string | null>('settings:setRegistryUrl', ' https://mirror.example/npm/ ')
    expect(r).toEqual({ ok: true, value: 'https://mirror.example/npm' })
    expect(loadSettings().registryUrl).toBe('https://mirror.example/npm')
  })

  it('clears the setting with an empty value, which is not an error', async () => {
    expect(await call('settings:setRegistryUrl', '')).toEqual({ ok: true, value: null })
    expect(loadSettings().registryUrl).toBeUndefined()
  })
})

describe('settings:setRegistryScope', () => {
  it('normalizes the two spellings a person might type into one', async () => {
    expect(await call<string | null>('settings:setRegistryScope', 'hamo-studio'))
      .toEqual({ ok: true, value: '@hamo-studio' })
    expect(await call<string | null>('settings:setRegistryScope', ' @hamo-studio '))
      .toEqual({ ok: true, value: '@hamo-studio' })
    expect(loadSettings().registryScope).toBe('@hamo-studio')
  })

  it('refuses a value that is not a scope, naming it', async () => {
    // Saved-and-ignored would be the worst outcome: the router would fall back to
    // "no scope", which sends EVERY package to the private registry.
    expect(await call('settings:setRegistryScope', 'has space'))
      .toMatchObject({ ok: false, code: 'registry.badScope', params: { detail: 'has space' } })
    expect(loadSettings().registryScope).toBe('@hamo-studio')
  })

  it('clears with an empty value, which means "the registry answers for all"', async () => {
    expect(await call<string | null>('settings:setRegistryScope', '')).toEqual({ ok: true, value: null })
    expect(loadSettings().registryScope).toBeUndefined()
  })
})

describe('settings:registry token', () => {
  it('answers two facts about the token and never the token', async () => {
    // The renderer must not be able to read the value back, not even through a
    // state object that happens to carry it.
    const saved = await call<{ configured: boolean; encryption: string }>('settings:setRegistryToken', 'secret-token')
    expect(saved).toEqual({ ok: true, value: { configured: true, encryption: 'plaintext' } })
    const state = await call<unknown>('settings:getRegistryAuth')
    expect(JSON.stringify(state)).not.toContain('secret-token')
  })

  it('clears with an empty value', async () => {
    expect(await call<{ configured: boolean }>('settings:setRegistryToken', ''))
      .toEqual({ ok: true, value: { configured: false, encryption: 'none' } })
    expect(loadSettings().registryTokenEnc).toBeUndefined()
  })
})
