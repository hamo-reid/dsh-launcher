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
import { openDatabase, patchSettings } from '../../core/settings/settings.ts'
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

describe('settings:mirror mode', () => {
  const reset = (): void => { patchSettings({ registries: undefined }) }

  it('saves a mirror and reports it back', async () => {
    reset()
    const r = await call<{ catchAll?: boolean; scopes: string[] }[]>('settings:saveRegistry',
      { label: 'nexus', url: 'https://nexus.corp.example/npm', scopes: [], catchAll: true })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value[0]?.catchAll).toBe(true)
    expect(r.value[0]?.scopes).toEqual([])
  })

  it('refuses a mirror that also lists scopes', async () => {
    reset()
    const r = await call('settings:saveRegistry',
      { label: 'nexus', url: 'https://nexus.corp.example/npm', scopes: ['@team'], catchAll: true })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('registry.modeConflict')
  })

  it('refuses a second mirror', async () => {
    reset()
    await call('settings:saveRegistry',
      { label: 'a', url: 'https://a.example', scopes: [], catchAll: true })
    const r = await call('settings:saveRegistry',
      { label: 'b', url: 'https://b.example', scopes: [], catchAll: true })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('registry.duplicateMirror')
  })
})

describe('settings:registries', () => {
  // A clean list for each case: these handlers read and write one array, so a
  // leftover entry would make the next expectation depend on the last one.
  const reset = (): void => { patchSettings({ registries: undefined }) }

  it('refuses an unparseable value with its own code AND the offending text', async () => {
    reset()
    const r = await call('settings:saveRegistry', { label: '', url: 'not a url', scopes: [] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('registry.badUrl')
    expect(JSON.stringify(r.params)).toContain('not a url')
  })

  it('refuses a non-http(s) scheme the same way', async () => {
    reset()
    const r = await call('settings:saveRegistry', { label: '', url: 'file:///etc', scopes: [] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('registry.badScheme')
  })

  it('accepts a mirror URL normalized, deriving a label from the host', async () => {
    reset()
    const r = await call<{ id: string; label: string; url: string }[]>('settings:saveRegistry',
      { label: '', url: 'https://mirror.example/npm/', scopes: ['@mirror'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toHaveLength(1)
    expect(r.value[0]?.url).toBe('https://mirror.example/npm')
    expect(r.value[0]?.label).toBe('mirror.example')
  })

  it('normalizes the two spellings of a scope into one', async () => {
    reset()
    const r = await call<{ scopes: string[] }[]>('settings:saveRegistry',
      { label: 'private', url: 'https://npm.internal.example', scopes: ['myorg'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value[0]?.scopes).toEqual(['@myorg'])
  })

  it('refuses a value that is not a scope, naming it', async () => {
    reset()
    const r = await call('settings:saveRegistry', { label: 'x', url: 'https://npm.internal.example', scopes: ['@'] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('registry.badScope')
  })

  it('refuses an entry with no scope', async () => {
    // Without a scope the entry would answer for every package no other scope
    // claims — the ambiguity this model removed. A source always owns a set.
    reset()
    const r = await call('settings:saveRegistry', { label: 'mirror', url: 'https://mirror.example', scopes: [] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('registry.scopeRequired')
  })

  it('allows several sources, each owning a different scope', async () => {
    reset()
    const first = await call('settings:saveRegistry',
      { label: 'team', url: 'https://npm.internal.example/team', scopes: ['@team'] })
    expect(first.ok).toBe(true)
    const second = await call('settings:saveRegistry',
      { label: 'other', url: 'https://npm.other.example', scopes: ['@other'] })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.value).toHaveLength(2)
  })

  it('refuses a second entry claiming the same scope', async () => {
    reset()
    await call('settings:saveRegistry', { label: 'a', url: 'https://a.example', scopes: ['@team'] })
    const r = await call('settings:saveRegistry', { label: 'b', url: 'https://b.example', scopes: ['@team'] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('registry.duplicateScope')
  })

  it('updates an entry in place and keeps its credential', async () => {
    reset()
    const added = await call<{ id: string }[]>('settings:saveRegistry',
      { label: 'a', url: 'https://a.example', scopes: ['@team'] })
    if (!added.ok) throw new Error('setup failed')
    const id = added.value[0]?.id ?? ''
    await call('settings:saveRegistry', { id, label: 'renamed', url: 'https://a.example', scopes: ['@team'], token: 'secret' })
    const r = await call<{ label: string; hasToken: boolean }[]>('settings:saveRegistry',
      { id, label: 'renamed twice', url: 'https://a.example', scopes: ['@team'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // No `token` in the input: an edit must not wipe the saved credential.
    expect(r.value[0]?.label).toBe('renamed twice')
    expect(r.value[0]?.hasToken).toBe(true)
  })

  it('answers two facts about a token and never the token', async () => {
    reset()
    const added = await call<{ id: string }[]>('settings:saveRegistry',
      { label: 'a', url: 'https://a.example', scopes: ['@team'] })
    if (!added.ok) throw new Error('setup failed')
    const id = added.value[0]?.id ?? ''
    const r = await call<{ hasToken: boolean; encryption: string }[]>('settings:saveRegistry',
      { id, label: 'a', url: 'https://a.example', scopes: ['@team'], token: 'secret-token' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value[0]?.hasToken).toBe(true)
    expect(JSON.stringify(r.value)).not.toContain('secret-token')
  })

  it('clears a token with an empty value', async () => {
    reset()
    const added = await call<{ id: string }[]>('settings:saveRegistry',
      { label: 'a', url: 'https://a.example', scopes: ['@team'], token: 'secret' })
    if (!added.ok) throw new Error('setup failed')
    const id = added.value[0]?.id ?? ''
    const r = await call<{ hasToken: boolean }[]>('settings:saveRegistry',
      { id, label: 'a', url: 'https://a.example', scopes: ['@team'], token: '' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value[0]?.hasToken).toBe(false)
  })

  it('removes an entry, and refuses an unknown id', async () => {
    reset()
    const added = await call<{ id: string }[]>('settings:saveRegistry',
      { label: 'a', url: 'https://a.example', scopes: ['@team'] })
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
    await call('settings:saveRegistry', { label: 'a', url: 'https://a.example', scopes: ['@team'], token: 'secret' })
    const r = await call<unknown[]>('settings:listRegistries')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toHaveLength(1)
    expect(JSON.stringify(r.value)).not.toContain('secret')
  })
})
