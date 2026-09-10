/**
 * Launch-command wiring tests. The whole point of `launch-spec` is that the
 * bundled Electron-as-node path sets ELECTRON_RUN_AS_NODE for itself while
 * preloading a shim that clears it before dsh/pnpm can spawn children, and that
 * the system-node path carries neither. These run in the node test environment
 * with no electron dependency.
 */
import { describe, expect, it } from 'vitest'
import type { LaunchEntry } from './dsh.ts'
import {
  buildDshLaunch, buildNodeScriptLaunch, ELECTRON_NODE_SHIM, type NodeTarget,
} from './launch-spec.ts'

const PUBLISHED: LaunchEntry = { script: 'C:/dsh/lib/bin.js', tsx: false, cwd: 'C:/dsh' }
const SOURCE: LaunchEntry = { script: 'C:/repo/apps/cli/src/bin.ts', tsx: true, cwd: 'C:/repo' }
const SYSTEM: NodeTarget = { exe: 'node', bundled: false }
const BUNDLED: NodeTarget = { exe: 'C:/app/electron.exe', bundled: true }

describe('buildDshLaunch', () => {
  it('omits the shim and the variable for a system node', () => {
    const spec = buildDshLaunch({ launch: PUBLISHED, home: 'H', node: SYSTEM, profile: 'p' })
    expect(spec.exe).toBe('node')
    expect(spec.argv).toEqual(['--expose-internals', PUBLISHED.script, '--profile', 'p'])
    expect(spec.argv).not.toContain(ELECTRON_NODE_SHIM)
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(spec.env.DSH_HOME).toBe('H')
  })

  it('preloads the shim and sets the variable for bundled Electron', () => {
    const spec = buildDshLaunch({ launch: PUBLISHED, home: 'H', node: BUNDLED, profile: 'p' })
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(spec.argv.slice(0, 2)).toEqual(['--import', ELECTRON_NODE_SHIM])
    // The shim must run before the app entry it is protecting.
    expect(spec.argv.indexOf(ELECTRON_NODE_SHIM)).toBeLessThan(spec.argv.indexOf(PUBLISHED.script))
  })

  it('puts the shim before the tsx loader for a source checkout', () => {
    const spec = buildDshLaunch({ launch: SOURCE, home: 'H', node: BUNDLED, profile: 'p' })
    expect(spec.argv).toContain('tsx/esm')
    expect(spec.argv.indexOf(ELECTRON_NODE_SHIM)).toBeLessThan(spec.argv.indexOf('tsx/esm'))
    expect(spec.argv.indexOf('tsx/esm')).toBeLessThan(spec.argv.indexOf(SOURCE.script))
  })

  it('strips a stale variable from the launcher env on both branches', () => {
    const prev = process.env.ELECTRON_RUN_AS_NODE
    process.env.ELECTRON_RUN_AS_NODE = '1'
    try {
      expect(buildDshLaunch({ launch: PUBLISHED, home: 'H', node: SYSTEM, profile: 'p' }).env.ELECTRON_RUN_AS_NODE).toBeUndefined()
      expect(buildDshLaunch({ launch: PUBLISHED, home: 'H', node: BUNDLED, profile: 'p' }).env.ELECTRON_RUN_AS_NODE).toBe('1')
    } finally {
      if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE
      else process.env.ELECTRON_RUN_AS_NODE = prev
    }
  })
})

describe('buildNodeScriptLaunch (pnpm)', () => {
  it('preloads the shim only for the bundled Electron', () => {
    const sys = buildNodeScriptLaunch({ node: SYSTEM, script: 'pnpm.cjs', args: ['install'] })
    expect(sys.exe).toBe('node')
    expect(sys.argv).toEqual(['pnpm.cjs', 'install'])
    expect(sys.env.ELECTRON_RUN_AS_NODE).toBeUndefined()

    const bun = buildNodeScriptLaunch({ node: BUNDLED, script: 'pnpm.cjs', args: ['install'] })
    expect(bun.exe).toBe(BUNDLED.exe)
    expect(bun.argv).toEqual(['--import', ELECTRON_NODE_SHIM, 'pnpm.cjs', 'install'])
    expect(bun.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})
