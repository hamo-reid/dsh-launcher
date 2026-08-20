/**
 * Node runtime selection: given detection + the user's preference, which node
 * (bundled vs system) dsh runs with. `spawnSync` (the system-node probe) is
 * stubbed; the bundled version is read from the runner's process.versions.node.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
import { spawnSync } from 'node:child_process'
import type { NodeEnvironment } from '../../shared/types.ts'

let nodeEnvironment: (pref: 'system' | 'bundled') => NodeEnvironment

beforeEach(async () => {
  vi.resetModules()
  vi.mocked(spawnSync).mockReset()
  nodeEnvironment = (await import('./node-env.ts')).nodeEnvironment
})

function stubSystem(stdout: string, status = 0): void {
  vi.mocked(spawnSync).mockReturnValue({ status, stdout: `${stdout}\n`, stderr: '' } as never)
}

describe('nodeEnvironment', () => {
  it('prefers a usable system node when preference = system (>= 22.6)', () => {
    stubSystem('v24.3.1')
    const env = nodeEnvironment('system')
    expect(env.system).toEqual({ installed: true, version: 'v24.3.1' })
    expect(env.preference).toBe('system')
    expect(env.prefer).toBe('system')
    expect(env.bundled).toBe(process.versions.node)
  })

  it('always uses bundled when preference = bundled, even if a system node exists', () => {
    stubSystem('v24.3.1')
    const env = nodeEnvironment('bundled')
    expect(env.prefer).toBe('bundled')
    expect(env.preference).toBe('bundled')
  })

  it('falls back to bundled when preference=system but the system node is too old', () => {
    stubSystem('v20.18.3')
    expect(nodeEnvironment('system').prefer).toBe('bundled')
  })

  it('falls back to bundled when preference=system but no system node exists', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: '' } as never)
    const env = nodeEnvironment('system')
    expect(env.system).toEqual({ installed: false, version: '' })
    expect(env.prefer).toBe('bundled')
  })
})