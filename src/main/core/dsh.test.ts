/**
 * Tests for dsh discovery: package-root resolution (publish vs source) and the
 * global-bin slot scan. Uses temp dirs / env overrides; no real dsh needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  baseLaunch, defaultHome, detectExecutables, discoverVersionRepo, entryFromPath,
  existsExecutable, installDir, isDeletableDsh, isManagedInstall, readVersionFromPath,
  resolveDshPackage, resolveLaunchEntry, type DshEntry,
} from './dsh.ts'

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

describe('isManagedInstall / path-derived deletable', () => {
  let repo = ''
  let shim = ''
  // Build the tree in a describe-level beforeAll (runs after the top-level one
  // has created `root`), so dir() paths resolve into a real temp dir.
  beforeAll(() => {
    repo = dir('repo')
    shim = join(dir('repo/official/node_modules/.bin'), 'dsh.cmd')
    writeFileSync(shim, '@echo off')
  })

  const inside = (execPath: string) => ({ id: execPath, name: 'official', execPath, version: '1', home: join(root, 'homes', 'official') })

  it('derives managed from the repo path when the marker was clobbered', () => {
    // no persisted managed marker (e.g. overwritten by a manual re-registration),
    // yet the executable still lives under the repo → derivable as deletable
    expect(isDeletableDsh(inside(shim), repo)).toBe(true)
  })

  it('rejects an install whose root sits outside the repo', () => {
    expect(isDeletableDsh(inside(join(dir('elsewhere'), 'dsh.cmd')), repo)).toBe(false)
  })

  it('isManagedInstall prefers the recorded entry.versionDir over the passed root', () => {
    const other = join(root, 'other-repo')
    expect(isManagedInstall({ ...inside(shim), versionDir: repo }, other)).toBe(true)
    expect(isManagedInstall({ ...inside(shim), versionDir: other }, repo)).toBe(false)
  })
})

describe('discoverVersionRepo', () => {
  it('returns [] when the version dir is missing', () => {
    expect(discoverVersionRepo([], join(root, 'no-repo'))).toEqual([])
  })

  it('finds an unregistered dsh install on disk', () => {
    const repo = dir('vrepo')
    const pkgDir = dir('vrepo/v2/node_modules/@deepseek-ai/dsh')
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.0.0' }))
    writeFileSync(join(dir('vrepo/v2/node_modules/.bin'), 'dsh.cmd'), '@echo off')

    const found = discoverVersionRepo([], repo)
    expect(found).toHaveLength(1)
    expect(found[0].name).toBe('v2')
    expect(found[0].version).toBe('2.0.0')
    expect(found[0].managed).toBe(true)
    expect(found[0].versionDir).toBe(repo)
    expect(found[0].home).toBe(join(dirname(repo), 'homes', 'v2'))
  })

  it('skips already-registered installs and unrelated dirs', () => {
    const repo = dir('vrepo2')
    writeFileSync(join(dir('vrepo2/known/node_modules/@deepseek-ai/dsh'), 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' }))
    const execPath = join(dir('vrepo2/known/node_modules/.bin'), 'dsh.cmd')
    writeFileSync(execPath, '@echo off')
    dir('vrepo2/notes') // unrelated: no dsh manifest → skipped

    const known: DshEntry = { id: execPath, name: 'known', execPath, version: '1.0.0', home: '/h' }
    expect(discoverVersionRepo([known], repo)).toEqual([])
  })

  it('finds multiple versions, one per subdir', () => {
    const repo = dir('vrepo3')
    for (const v of ['a', 'b']) {
      writeFileSync(join(dir(`vrepo3/${v}/node_modules/@deepseek-ai/dsh`), 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: `0.${v}.0` }))
      writeFileSync(join(dir(`vrepo3/${v}/node_modules/.bin`), 'dsh.cmd'), '@echo off')
    }
    const found = discoverVersionRepo([], repo)
    expect(found.map(x => x.name).sort()).toEqual(['a', 'b'])
    expect(found.every(x => x.managed === true)).toBe(true)
  })
})
describe('baseLaunch', () => {
  it('maps a source checkout to a node/tsx command', () => {
    const checkout = dir('launch-src')
    mkdirSync(join(checkout, 'apps', 'cli', 'src'), { recursive: true })
    writeFileSync(join(checkout, 'apps', 'cli', 'src', 'bin.ts'), '')
    const cmd = baseLaunch(checkout)
    expect(cmd).toBe(`node --import tsx/esm "${join(checkout, 'apps', 'cli', 'src', 'bin.ts')}"`)
  })

  it('passes a plain executable through unchanged', () => {
    const plain = dir('launch-plain')
    expect(baseLaunch(plain)).toBe(plain)
  })
})

describe('defaultHome / readVersionFromPath', () => {
  it('defaultHome points at ~/.dsh', () => {
    expect(defaultHome()).toContain('.dsh')
  })

  it('readVersionFromPath walks up to the version manifest', () => {
    writeJson('walk/dir/.dsh/versions/v1', { version: '9.9.9' })
    const inner = dir('walk/dir/.dsh/versions/v1/deep/nest')
    expect(readVersionFromPath(inner)).toBe('9.9.9')
  })
})

describe('installDir / existsExecutable', () => {
  it('installDir resolves a quoted command to its real dir', () => {
    const bin = writeJson('inst/cmd/real-dsh', { version: '1.0.0' })
    const target = join(bin, 'real-dsh')
    writeFileSync(target, '#!/usr/bin/env node')
    expect(installDir(`node "${target}"`)).toBe(target)
  })

  it('existsExecutable is true for a real file and false for a miss', () => {
    const bin = dir('exec')
    const file = join(bin, 'dsh.bin')
    writeFileSync(file, '')
    expect(existsExecutable(file)).toBe(true)
    expect(existsExecutable(join(bin, 'missing'))).toBe(false)
    expect(existsExecutable(`node "${file}"`)).toBe(true)
  })
})

describe('entryFromPath', () => {
  it('builds an entry from a plain file (version from manifest)', async () => {
    const bin = writeJson('entry/bin', { version: '2.3.4' })
    const file = join(bin, 'dsh.bin')
    writeFileSync(file, '')
    const entry = await entryFromPath(file)
    expect(entry.execPath).toBe(file)
    expect(entry.version).toBe('2.3.4')
    expect(entry.name).toBe('dsh@2.3.4')
  })

  it('builds an entry from a source checkout dir', async () => {
    const checkout = dir('entry-src')
    mkdirSync(join(checkout, 'apps', 'cli', 'src'), { recursive: true })
    writeFileSync(join(checkout, 'apps', 'cli', 'src', 'bin.ts'), '')
    writeJson('entry-src/apps/cli', { name: '@deepseek-ai/dsh', version: '1.2.3' })
    const entry = await entryFromPath(checkout)
    expect(entry.execPath).toContain('node --import tsx/esm')
    expect(entry.version).toBe('1.2.3')
  })

  it('throws for a missing path', async () => {
    await expect(entryFromPath(join(root, 'nope'))).rejects.toThrow(/path not found/)
  })
})

describe('resolveLaunchEntry', () => {
  it('maps a published install to its bin script (bundle node runnable)', () => {
    const pkg = writeJson('launch/pub/node_modules/@deepseek-ai/dsh', {
      name: '@deepseek-ai/dsh', version: '1', bin: { dsh: 'lib/cli.js' },
    })
    mkdirSync(join(pkg, 'lib'), { recursive: true })
    writeFileSync(join(pkg, 'lib', 'cli.js'), '')
    const shim = join(root, 'launch', 'pub', 'node_modules', '.bin', 'dsh.cmd')
    mkdirSync(join(root, 'launch', 'pub', 'node_modules', '.bin'), { recursive: true })
    writeFileSync(shim, '@echo off')

    const e = resolveLaunchEntry(shim)
    expect(e.tsx).toBe(false)
    expect(e.script).toBe(join(pkg, 'lib', 'cli.js'))
    expect(e.cwd).toBe(pkg)
  })

  it('maps a source checkout through the tsx loader', () => {
    const cli = writeJson('launch/src/apps/cli', { name: '@deepseek-ai/dsh', version: '1' })
    mkdirSync(join(cli, 'src'), { recursive: true })
    writeFileSync(join(cli, 'src', 'bin.ts'), '')
    const e = resolveLaunchEntry(cli)
    expect(e.tsx).toBe(true)
    expect(e.script).toBe(join(cli, 'src', 'bin.ts'))
    expect(e.cwd).toBe(cli)
  })

  it('falls back to a raw .js file as-is', () => {
    const file = join(dir('launch/raw'), 'cli.js')
    writeFileSync(file, '')
    const e = resolveLaunchEntry(file)
    expect(e.tsx).toBe(false)
    expect(e.script).toBe(file)
  })

  it('throws when no bundle-node-friendly entry can be mapped', () => {
    const bad = join(dir('launch/nopkg'), 'dsh.bin')
    writeFileSync(bad, '')
    expect(() => resolveLaunchEntry(bad)).toThrow(/无法解析 dsh 启动入口/)
  })
})
