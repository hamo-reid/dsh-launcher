/**
 * Tests for dsh discovery: package-root resolution (publish vs source) and the
 * global-bin slot scan. Uses temp dirs / env overrides; no real dsh needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectExecutables, isDeletableDsh, resolveDshPackage } from './dsh.ts'

let root: string

function dir(...segments: string[]): string {
  const p = join(root, ...segments)
  mkdirSync(p, { recursive: true })
  return p
}
function writeJson(rel: string, obj: unknown): string {
  const p = dir(...rel.split('/'))
  writeFileSync(join(p, 'package.json'), JSON.stringify(obj))
  return p
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pm-dsh-'))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('resolveDshPackage', () => {
  it('finds a published @deepseek-ai/dsh package from a .bin shim', () => {
    const pkg = writeJson('publish/node_modules/@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: '0.1.0-rc.5' })
    const shim = join(root, 'publish', 'node_modules', '.bin', 'dsh.cmd')
    mkdirSync(join(root, 'publish', 'node_modules', '.bin'), { recursive: true })
    writeFileSync(shim, '@echo off\r\nnode "%~dp0\\..\\@deepseek-ai\\dsh\\lib\\bin.js"')

    const r = resolveDshPackage(shim)
    expect(r).toBeDefined()
    expect(r?.kind).toBe('publish')
    expect(r?.version).toBe('0.1.0-rc.5')
    expect(r?.root).toBe(pkg)
  })

  it('detects a source checkout via apps/cli/package.json', () => {
    const cli = writeJson('source/apps/cli', { name: '@deepseek-ai/dsh', version: '1.2.3' })
    // a path into the checkout (apps/cli/src/bin.ts)
    const entry = join(root, 'source', 'apps', 'cli', 'src', 'bin.ts')
    const r = resolveDshPackage(entry)
    expect(r).toBeDefined()
    expect(r?.kind).toBe('source')
    expect(r?.version).toBe('1.2.3')
    expect(r?.root).toBe(cli)
    expect(entry.startsWith(r!.root ?? '/')).toBe(true)
  })

  it('returns undefined when no dsh package is around', () => {
    const empty = dir('empty/nested')
    expect(resolveDshPackage(join(empty, 'dsh'))).toBeUndefined()
  })
})

describe('detectExecutables', () => {
  it('scans APPDATA global slots (win) and dedupes', async () => {
    const prev = process.env.APPDATA
    const appdata = join(root, 'appdata')
    mkdirSync(join(appdata, 'npm'), { recursive: true })
    mkdirSync(join(appdata, 'pnpm'), { recursive: true })
    writeFileSync(join(appdata, 'npm', 'dsh.cmd'), '@echo off')
    writeFileSync(join(appdata, 'pnpm', 'dsh.exe'), 'binary')

    process.env.APPDATA = appdata
    try {
      const list = await detectExecutables()
      if (process.platform === 'win32') {
        expect(list).toContain(realpathSync(join(appdata, 'npm', 'dsh.cmd')))
        expect(list).toContain(realpathSync(join(appdata, 'pnpm', 'dsh.exe')))
      }
      // no duplicates
      expect(new Set(list).size).toBe(list.length)
    } finally {
      if (prev === undefined) delete process.env.APPDATA
      else process.env.APPDATA = prev
    }
  })
})

describe('isDeletableDsh', () => {
  const base = { id: 'x', name: 'x', execPath: 'x', version: '1', home: '/h' }
  it('is true only for app-managed (official install) dsh', () => {
    expect(isDeletableDsh({ ...base, managed: true })).toBe(true)
  })
  it('is false for system/globally-installed or manually added dsh', () => {
    // 缺省（检测/手动/路径添加都不打标）
    expect(isDeletableDsh(base)).toBe(false)
    expect(isDeletableDsh({ ...base, managed: false })).toBe(false)
  })
})