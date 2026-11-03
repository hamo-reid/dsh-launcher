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
import { openDatabase, loadSettings, patchSettings } from '../../core/settings/settings.ts'
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

describe('settings:registries', () => {
  // A clean list for each case: these handlers read and write one array, so a
  // leftover entry would make the next expectation depend on the last one.
  const reset = (): void => { patchSettings({ registries: undefined }) }

  it('refuses an unparseable value with its own code AND the offending text', async () => {
    reset()
    const r = await call('settings:saveRegistry', { label: '', url: 'not a url', scope: '' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('registry.badUrl')
    expect(JSON.stringify(r.params)).toContain('not a url')
  })

  it('refuses a non-http(s) scheme the same way', async () => {
    reset()
    const r = await call('settings:saveRegistry', { label: '', url: 'file:///etc', scope: '' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('registry.badScheme')
  })

  it('accepts a mirror URL normalized, deriving a label from the host', async () => {
    reset()
    const r = await call<{ id: string; label: string; url: string }[]>('settings:saveRegistry',
      { label: '', url: 'https://mirror.example/npm/', scope: '' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toHaveLength(1)
    expect(r.value[0]?.url).toBe('https://mirror.example/npm')
    expect(r.value[0]?.label).toBe('mirror.example')
  })

  it('normalizes the two spellings of a scope into one', async () => {
    reset()
    const r = await call<{ scope?: string }[]>('settings:saveRegistry',
      { label: 'private', url: 'https://npm.internal.example', scope: 'myorg' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value[0]?.scope).toBe('@myorg')
  })

  it('refuses a value that is not a scope, naming it', async () => {
    reset()
    const r = await call('settings:saveRegistry', { label: 'x', url: 'https://npm.internal.example', scope: '@' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('registry.badScope')
  })

  it('allows several sources, but only one of them unscoped', async () => {
    // Routing needs exactly one answer for a package no scope claims; two
    // unscoped entries would be two answers, so the second is refused.
    reset()
    const scoped = await call('settings:saveRegistry',
      { label: 'team', url: 'https://npm.internal.example/team', scope: '@team' })
    expect(scoped.ok).toBe(true)
    const fallback = await call('settings:saveRegistry',
      { label: 'mirror', url: 'https://mirror.example', scope: '' })
    expect(fallback.ok).toBe(true)
    const second = await call('settings:saveRegistry',
      { label: 'mirror2', url: 'https://mirror2.example', scope: '' })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.code).toBe('registry.duplicateFallback')
  })

  it('refuses a second entry claiming the same scope', async () => {
    reset()
    await call('settings:saveRegistry', { label: 'a', url: 'https://a.example', scope: '@team' })
    const r = await call('settings:saveRegistry', { label: 'b', url: 'https://b.example', scope: '@team' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('registry.duplicateScope')
  })

  it('updates an entry in place and keeps its credential', async () => {
    reset()
    const added = await call<{ id: string }[]>('settings:saveRegistry',
      { label: 'a', url: 'https://a.example', scope: '@team' })
    if (!added.ok) throw new Error('setup failed')
    const id = added.value[0]?.id ?? ''
    await call('settings:saveRegistry', { id, label: 'renamed', url: 'https://a.example', scope: '@team', token: 'secret' })
    const r = await call<{ label: string; hasToken: boolean }[]>('settings:saveRegistry',
      { id, label: 'renamed twice', url: 'https://a.example', scope: '@team' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // No `token` in the input: an edit must not wipe the saved credential.
    expect(r.value[0]?.label).toBe('renamed twice')
    expect(r.value[0]?.hasToken).toBe(true)
  })

  it('answers two facts about a token and never the token', async () => {
    reset()
    const added = await call<{ id: string }[]>('settings:saveRegistry',
      { label: 'a', url: 'https://a.example', scope: '@team' })
    if (!added.ok) throw new Error('setup failed')
    const id = added.value[0]?.id ?? ''
    const r = await call<{ hasToken: boolean; encryption: string }[]>('settings:saveRegistry',
      { id, label: 'a', url: 'https://a.example', scope: '@team', token: 'secret-token' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value[0]?.hasToken).toBe(true)
    expect(JSON.stringify(r.value)).not.toContain('secret-token')
  })

  it('clears a token with an empty value', async () => {
    reset()
    const added = await call<{ id: string }[]>('settings:saveRegistry',
      { label: 'a', url: 'https://a.example', scope: '@team', token: 'secret' })
    if (!added.ok) throw new Error('setup failed')
    const id = added.value[0]?.id ?? ''
    const r = await call<{ hasToken: boolean }[]>('settings:saveRegistry',
      { id, label: 'a', url: 'https://a.example', scope: '@team', token: '' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value[0]?.hasToken).toBe(false)
  })

  it('removes an entry, and refuses an unknown id', async () => {
    reset()
    const added = await call<{ id: string }[]>('settings:saveRegistry',
      { label: 'a', url: 'https://a.example', scope: '@team' })
    if (!added.ok) throw new Error('setup failed')
    const id = added.value[0]?.id ?? ''
    const removed = await call('settings:removeRegistry', id)
    expect(removed.ok).toBe(true)
    if (removed.ok) expect(removed.value).toHaveLength(0)
    const again = await call('settings:removeRegistry', id)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe('registry.entryMissing')
  })

  it('lists what is configured, without any token value', async () => {
    reset()
    await call('settings:saveRegistry', { label: 'a', url: 'https://a.example', scope: '@team', token: 'secret' })
    const r = await call<unknown[]>('settings:listRegistries')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toHaveLength(1)
    expect(JSON.stringify(r.value)).not.toContain('secret')
  })
})
