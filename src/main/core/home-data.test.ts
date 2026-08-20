/** Tests for the home-data archival core: exclusion rules, `.bak` semantics,
 * profile-minimal copying, and the zip export/import round-trip. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import {
  archiveHome, copyDshHome, exportDshData, importDshData, listMigratableHomeData, restoreHome,
} from './home-data.ts'
import type { DshContext } from './appState.ts'

let root: string
let home: string
let srcData: string

function dir(...segments: string[]): string {
  const p = isAbsolute(segments[0]) ? segments[0] : join(root, ...segments)
  mkdirSync(p, { recursive: true })
  return p
}
function file(rel: string, content = 'x'): string {
  const p = isAbsolute(rel) ? rel : join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pm-homedata-'))
  home = dir('home')
  srcData = dir('src')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const ctx = (h: string, version = '1.2.3'): DshContext => ({ home: h, version })

describe('listMigratableHomeData', () => {
  it('lists only existing migratable entries', () => {
    const h = dir('lmd-home')
    file(join(h, 'settings.yaml', 'f'))
    file(join(h, 'sessions', 's'))
    expect(listMigratableHomeData(h)).toEqual(['sessions', 'settings.yaml']) // MIGRATABLE_TOP_LEVEL order
  })
})

describe('archiveHome / restoreHome', () => {
  it('copies home-level data and skips non-migratable entries', () => {
    const h = dir('a-home')
    file(join(h, '.credentials.yaml'))
    file(join(h, 'sessions', 'p', 's', 'session.jsonl'))
    file(join(h, 'node_modules', 'junk'))
    file(join(h, 'profiles', 'web', 'package.json'))
    file(join(h, 'profiles', 'web', 'cordis.patch.yml'))
    file(join(h, 'profiles', 'web', 'cordis.yml')) // boot-rewritten → excluded
    file(join(h, 'profiles', 'node_modules', 'x'))

    const dest = dir('a-dest')
    archiveHome(h, dest)

    expect(existsSync(join(dest, '.credentials.yaml'))).toBe(true)
    expect(existsSync(join(dest, 'sessions', 'p', 's', 'session.jsonl'))).toBe(true)
    // excluded: node_modules (home), profile cordis.yml, profiles/node_modules
    expect(existsSync(join(dest, 'node_modules'))).toBe(false)
    expect(existsSync(join(dest, 'profiles', 'web', 'cordis.yml'))).toBe(false)
    // profile minimal kept
    expect(existsSync(join(dest, 'profiles', 'web', 'package.json'))).toBe(true)
    expect(existsSync(join(dest, 'profiles', 'web', 'cordis.patch.yml'))).toBe(true)
  })

  it('restores into a clean home and `.bak`-backs up pre-existing files on re-run', () => {
    const h = dir('r-home')
    file(join(h, 'settings.yaml'), 'new')
    const dest = dir('r-src')
    file(join(dest, 'settings.yaml'), 'old')

    restoreHome(dest, h)
    expect(readFileSync(join(h, 'settings.yaml'), 'utf8')).toBe('old')

    // re-run with a different value → the previous one is `.bak`-backed up
    writeFileSync(join(dest, 'settings.yaml'), 'newer')
    restoreHome(dest, h)
    expect(readFileSync(join(h, 'settings.yaml'), 'utf8')).toBe('newer')
    expect(readFileSync(join(h, 'settings.yaml.bak'), 'utf8')).toBe('old')
  })
})

describe('copyDshHome', () => {
  it('mirrors migratable data between two homes directly', () => {
    const src = dir('c-src-home')
    file(join(src, 'settings.yaml'), 'v')
    file(join(src, 'profiles', 'web', 'package.json'))
    const tgt = dir('c-tgt-home')
    copyDshHome(src, tgt)
    expect(readFileSync(join(tgt, 'settings.yaml'), 'utf8')).toBe('v')
    expect(existsSync(join(tgt, 'profiles', 'web', 'package.json'))).toBe(true)
  })
})

describe('exportDshData / importDshData', () => {
  it('round-trips an archive into another home', () => {
    const h = dir('e-home')
    file(join(h, 'sessions', 'p', 's', 'session.jsonl'), 'SER')
    file(join(h, 'storages', 'workspace.json'), JSON.stringify({ version: 2, v: 1 }))
    file(join(h, '.credentials.yaml'), 'secret')
    file(join(h, 'profiles', 'web', 'package.json'), '{}')
    file(join(h, 'profiles', 'web', 'cordis.patch.yml'), '[]')

    const zip = join(root, 'out.zip')
    const manifest = exportDshData(ctx(h), zip)

    expect(manifest.dshVersion).toBe('1.2.3')
    expect(manifest.storageVersions['workspace.json']).toBe(2)

    const tgt = dir('e-tgt-home')
    const res = importDshData(ctx(tgt), zip)
    expect(res.ok).toBe(true)
    expect(res.dshMismatch).toBe(false)
    expect(readFileSync(join(tgt, 'sessions', 'p', 's', 'session.jsonl'), 'utf8')).toBe('SER')
    expect(readFileSync(join(tgt, '.credentials.yaml'), 'utf8')).toBe('secret')
    expect(JSON.parse(readFileSync(join(tgt, 'storages', 'workspace.json'), 'utf8')).v).toBe(1)
    expect(existsSync(join(tgt, 'profiles', 'web', 'package.json'))).toBe(true)
  })

  it('refuses a cross-major import unless forced', () => {
    const h = dir('x-home')
    const zip = join(root, 'x.zip')
    exportDshData(ctx(h, '1.0.0'), zip)
    const tgt = dir('x-tgt-home')
    const res = importDshData(ctx(tgt, '2.0.0'), zip)
    expect(res.ok).toBe(false)
    expect(res.dshMismatch).toBe(true)
    // not restored
    expect(existsSync(join(tgt, 'sessions'))).toBe(false)
    // forced → proceeds
    expect(importDshData(ctx(tgt, '2.0.0'), zip, { forceDsh: true }).ok).toBe(true)
  })
})