/** Tests for launch-parameter sanitization — the IPC-boundary guard that keeps a
 * user's extra args/env from retargeting the launcher or hijacking Node. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { effectiveArgs, sanitizeLaunchOptions } from './launch-options.ts'

let root: string
let patchFile: string
let patchDir: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pm-launchopts-'))
  patchFile = join(root, 'overlay.yml')
  patchDir = join(root, 'overlays')
  writeFileSync(patchFile, '- id: webserver\n')
  mkdirSync(patchDir)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('sanitizeLaunchOptions', () => {
  it('normalizes empty/invalid input to all-empty defaults', () => {
    expect(sanitizeLaunchOptions(undefined)).toEqual({ args: [], patches: [], env: {} })
    expect(sanitizeLaunchOptions({ args: 'nope', patches: null, env: [] })).toEqual({ args: [], patches: [], env: {} })
  })

  it('keeps app args and drops empty strings', () => {
    const s = sanitizeLaunchOptions({ args: ['--resume', '', 'abc'] })
    expect(s.args).toEqual(['--resume', 'abc'])
  })

  it('rejects launcher-owned flags smuggled through the app args', () => {
    expect(() => sanitizeLaunchOptions({ args: ['--profile', 'other'] })).toThrow()
    expect(() => sanitizeLaunchOptions({ args: ['--patch', 'x.yml'] })).toThrow()
  })

  it('rejects control characters in args', () => {
    expect(() => sanitizeLaunchOptions({ args: ['a\nb'] })).toThrow()
  })

  it('accepts existing patch files and rejects missing/dir paths', () => {
    expect(sanitizeLaunchOptions({ patches: [patchFile] }).patches).toEqual([patchFile])
    expect(() => sanitizeLaunchOptions({ patches: [join(root, 'nope.yml')] })).toThrow()
    expect(() => sanitizeLaunchOptions({ patches: [patchDir] })).toThrow()
  })

  it('accepts valid env and rejects bad keys, reserved keys and control values', () => {
    expect(sanitizeLaunchOptions({ env: { DSH_TELEMETRY_DISABLED: '1' } }).env).toEqual({ DSH_TELEMETRY_DISABLED: '1' })
    expect(() => sanitizeLaunchOptions({ env: { '1BAD': 'x' } })).toThrow()
    expect(() => sanitizeLaunchOptions({ env: { PATH: '/evil' } })).toThrow()
    expect(() => sanitizeLaunchOptions({ env: { ELECTRON_RUN_AS_NODE: '0' } })).toThrow()
    expect(() => sanitizeLaunchOptions({ env: { OK: 'a\nb' } })).toThrow()
  })

  it('validates the convenience port range', () => {
    expect(sanitizeLaunchOptions({ port: 0 }).port).toBe(0)
    expect(sanitizeLaunchOptions({ port: 65535 }).port).toBe(65535)
    expect(() => sanitizeLaunchOptions({ port: -1 })).toThrow()
    expect(() => sanitizeLaunchOptions({ port: 70000 })).toThrow()
    expect(() => sanitizeLaunchOptions({ port: 1.5 })).toThrow()
  })
})

describe('effectiveArgs', () => {
  it('appends --port last when set, so it wins over a hand-written one', () => {
    expect(effectiveArgs({ args: ['--resume', 'x'], patches: [], env: {} })).toEqual(['--resume', 'x'])
    expect(effectiveArgs({ args: ['--port', '1'], patches: [], env: {}, port: 8080 })).toEqual(['--port', '1', '--port', '8080'])
  })
})
