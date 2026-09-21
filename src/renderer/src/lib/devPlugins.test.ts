/**
 * The dev-plugin page's decision logic.
 *
 * The two that carry real risk: a diagnosis with no report must not read as "ok"
 * (silence would look like health), and "missing" versus "dangling" must stay
 * distinct — they have different fixes (install the package versus repair the link).
 */
import { describe, expect, it } from 'vitest'
import {
  buildMenuItems, hostLabel, parseBuildKey, readSavedTarget, resolveDescriptor, sameTarget,
  saveTarget, scopeLabel, statusOf,
} from './devPlugins.ts'
import type { DevDiagnosis, DevDiagnosisMeta } from '../../../shared/types.ts'

const diagnosis = (over: Partial<DevDiagnosis> = {}): DevDiagnosis =>
  ({ entryMissing: false, missingPatchRows: [], missingPeers: [], ...over }) as DevDiagnosis

describe('the remembered target', () => {
  it('round-trips through storage, under a key that is pinned on purpose', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
    }
    saveTarget({ dshId: 'a', profile: 'p' }, storage)
    // Spelled out rather than read from TARGET_KEY: changing the key discards every
    // user's remembered compare target, so it has to be a decision, not a rename.
    expect([...store.keys()]).toEqual(['pm.dev.target'])
    expect(readSavedTarget(storage)).toEqual({ dshId: 'a', profile: 'p' })
  })

  it('drops blank and non-string fields rather than trusting the stored shape', () => {
    const storage = { getItem: () => JSON.stringify({ dshId: '', profile: 7 }) }
    expect(readSavedTarget(storage)).toEqual({})
    expect(readSavedTarget({ getItem: () => JSON.stringify({ dshId: 'a' }) })).toEqual({ dshId: 'a' })
  })

  it('reads nothing as an empty target, and survives unusable storage', () => {
    expect(readSavedTarget({ getItem: () => null })).toEqual({})
    expect(readSavedTarget({ getItem: () => 'not json' })).toEqual({})
    expect(readSavedTarget(undefined)).toEqual({})
    expect(() => saveTarget({ dshId: 'a' }, undefined)).not.toThrow()
    expect(() => saveTarget({ dshId: 'a' }, { setItem: () => { throw new Error('quota') } })).not.toThrow()
  })

  it('treats an absent profile as the same chain as a blank one', () => {
    expect(sameTarget({ dshId: 'a' }, { dshId: 'a', profile: '' })).toBe(true)
    expect(sameTarget({ dshId: 'a' }, { dshId: 'a', profile: 'p' })).toBe(false)
  })
})

describe('hostLabel', () => {
  it('appends the version only when the name does not already carry it', () => {
    expect(hostLabel({ name: 'dsh', version: '1.2.0' })).toBe('dsh (1.2.0)')
    expect(hostLabel({ name: 'dsh@1.2.0', version: '1.2.0' })).toBe('dsh@1.2.0')
    expect(hostLabel({ name: 'dsh' })).toBe('dsh')
  })

  it('falls back for an unknown host', () => {
    expect(hostLabel(undefined, 'known-name')).toBe('known-name')
    expect(hostLabel(undefined)).toBe('—')
  })
})

describe('statusOf', () => {
  it('is null without a report, so silence is not shown as health', () => {
    expect(statusOf(undefined)).toBeNull()
  })

  it('reports a missing entry ahead of anything else', () => {
    expect(statusOf(diagnosis({ entryMissing: true, missingPeers: [{ id: 'x' }] as never }))).toEqual({ kind: 'noEntry' })
  })

  it('counts both kinds of problem', () => {
    expect(statusOf(diagnosis({ missingPatchRows: [{ id: 'a' }] as never, missingPeers: [{ id: 'b' }, { id: 'c' }] as never })))
      .toEqual({ kind: 'issues', count: 3 })
  })

  it('is ok only when both lists are empty', () => {
    expect(statusOf(diagnosis())).toEqual({ kind: 'ok' })
  })
})

describe('resolveDescriptor', () => {
  it('reads an unresolved reference as missing', () => {
    expect(resolveDescriptor({})).toEqual({ kind: 'missing' })
  })

  it('keeps a dangling link distinct from a missing one', () => {
    expect(resolveDescriptor({ dir: '/x', state: 'dangling', link: '/gone' })).toEqual({ kind: 'dangling', target: '/gone' })
  })

  it('falls back to the dir when a dangling entry records no target', () => {
    expect(resolveDescriptor({ dir: '/x', state: 'dangling' })).toEqual({ kind: 'dangling', target: '/x' })
  })

  it('defaults a resolved reference to the monorepo root', () => {
    expect(resolveDescriptor({ dir: '/x', state: 'ok' })).toEqual({ kind: 'resolved', root: 'monorepo', peer: false })
    expect(resolveDescriptor({ dir: '/x', state: 'ok', root: 'host' }, true)).toEqual({ kind: 'resolved', root: 'host', peer: true })
  })
})

describe('scopeLabel', () => {
  const meta = (over: Partial<DevDiagnosisMeta> = {}): DevDiagnosisMeta =>
    ({ dshId: 'a', dshName: 'dsh', dshVersion: '1.2.0', at: '2026-09-21T10:00:00.000Z', ...over })
  const hosts = [{ id: 'a', name: 'dsh', version: '1.2.0' }]

  it('is null without a report, so nothing is claimed about a chain not yet used', () => {
    expect(scopeLabel(undefined, hosts)).toBeNull()
  })

  it('names the profile only when the report was computed for one', () => {
    expect(scopeLabel(meta({ profile: 'work' }), hosts)?.key).toBe('plugin.dev.detectedAt')
    expect(scopeLabel(meta({ profile: 'work' }), hosts)?.params.profile).toBe('work')
    expect(scopeLabel(meta({ profile: '' }), hosts)?.key).toBe('plugin.dev.detectedAtHost')
    expect(scopeLabel(meta(), hosts)?.key).toBe('plugin.dev.detectedAtHost')
  })

  it('keeps the recorded host name once that dsh is no longer installed', () => {
    expect(scopeLabel(meta(), [])?.params.host).toBe('dsh')
    expect(scopeLabel(meta(), hosts)?.params.host).toBe('dsh (1.2.0)')
  })

  it('renders an unusable timestamp as empty rather than "Invalid Date"', () => {
    expect(scopeLabel(meta({ at: 'nonsense' }), hosts)?.params.time).toBe('')
  })
})

describe('the build menu', () => {
  const labels = { package: 'package', workspace: 'workspace' }

  it('groups both scopes', () => {
    expect(buildMenuItems({ package: ['build'], workspace: ['compile'] }, labels)).toEqual([
      { type: 'group', label: 'package', children: [{ key: 'package:build', label: 'build' }] },
      { type: 'group', label: 'workspace', children: [{ key: 'workspace:compile', label: 'compile' }] },
    ])
  })

  it('leaves out an empty group instead of showing it empty', () => {
    expect(buildMenuItems({ package: ['build'], workspace: [] }, labels)).toHaveLength(1)
    expect(buildMenuItems(undefined, labels)).toEqual([])
  })

  it('reads a key back into its target, defaulting to the package scope', () => {
    expect(parseBuildKey('workspace:compile')).toEqual({ script: 'compile', scope: 'workspace' })
    expect(parseBuildKey('package:build')).toEqual({ script: 'build', scope: 'package' })
    expect(parseBuildKey('build')).toEqual({ script: 'build', scope: 'package' })
  })
})
