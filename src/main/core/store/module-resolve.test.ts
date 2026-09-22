/**
 * Where a name resolves on disk — the load-bearing tests for the pnpm-aware
 * lookup chain that `combo.ts` and `module-index.ts` share.
 *
 * The two facts pinned here are what make the shared chain work at all: a
 * junction path is on NO lookup chain (so the anchor must be realpathed), and the
 * install's chain is searched before the profile's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moduleSearchRoots, packageOf, resolveModule } from './module-resolve.ts'
import { contextForEntry } from '../profile/appState.ts'

let root: string

const home = (): string => join(root, 'home')
const anchor = (): string => join(root, 'install')
const nm = (): string => join(anchor(), 'node_modules')
/** dsh's real body inside pnpm's virtual store. */
const storeDir = (): string => join(nm(), '.pnpm', '@deepseek-ai+dsh@1.0.0_hash')
const dshReal = (): string => join(storeDir(), 'node_modules', '@deepseek-ai', 'dsh')

/** A pnpm-shaped install: the anchor's manifest, and `@deepseek-ai/dsh` as the
 * ONE entry under `@deepseek-ai/` — a junction into the store, exactly as
 * `installOfficialDsh` leaves it. Everything dsh depends on sits beside its body
 * in the store, reachable only through the lookup chain. */
function mkInstall(): void {
  mkdirSync(join(nm(), '.bin'), { recursive: true })
  writeFileSync(join(nm(), '.bin', 'dsh.cmd'), '')
  writeFileSync(join(anchor(), 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '1.0.0' } }))
  mkdirSync(dshReal(), { recursive: true })
  writeFileSync(join(dshReal(), 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0' }))
  mkdirSync(join(nm(), '@deepseek-ai'), { recursive: true })
  symlinkSync(dshReal(), join(nm(), '@deepseek-ai', 'dsh'), 'junction')
}

/** A package that is only a dependency OF dsh: it lives in the store beside dsh's
 * body, never under `<anchor>/node_modules/@deepseek-ai/`. */
function mkStorePackage(name: string): string {
  const dir = join(storeDir(), 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  return dir
}

const ctx = (): ReturnType<typeof contextForEntry> =>
  contextForEntry({ id: 'a', name: 'dsh@a', execPath: join(nm(), '.bin', 'dsh.cmd'), version: '1.0.0', home: home() })

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-modresolve-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(home(), 'profiles'), { recursive: true })
  mkInstall()
})

describe('packageOf', () => {
  it('keeps a bare name and strips a subpath', () => {
    expect(packageOf('hono')).toBe('hono')
    expect(packageOf('dsh-base/sub/x')).toBe('dsh-base')
  })

  it('keeps both segments of a scoped name', () => {
    expect(packageOf('@deepseek-ai/dsh-tool-bash')).toBe('@deepseek-ai/dsh-tool-bash')
    expect(packageOf('@deepseek-ai/dsh-web-app/startup')).toBe('@deepseek-ai/dsh-web-app')
    expect(packageOf('@deepseek-ai/dsh-tool-subagent/model-selection-settings')).toBe('@deepseek-ai/dsh-tool-subagent')
  })

  it('tolerates trailing slashes and whitespace', () => {
    expect(packageOf('  @s/p/  ')).toBe('@s/p')
    expect(packageOf('@scope')).toBe('@scope')
  })
})

describe('the install lookup chain', () => {
  it('reaches a transitive dependency of dsh that the flat root does not hold', () => {
    const dir = mkStorePackage('@deepseek-ai/dsh-base')
    // The fixture is faithful: `@deepseek-ai/` holds ONLY `dsh`. This is the
    // asymmetry a plain `join(root, name)` probe cannot cross.
    expect(existsSync(join(nm(), '@deepseek-ai', 'dsh-base'))).toBe(false)
    expect(resolveModule(ctx(), '@deepseek-ai/dsh-base')).toEqual({ dir, state: 'ok', root: 'host' })
  })

  it('a junction path contributes nothing to a chain — the realpath is what reaches the store', () => {
    const fromLink = createRequire(join(nm(), '@deepseek-ai', 'dsh', 'package.json')).resolve.paths('') ?? []
    const fromReal = createRequire(join(dshReal(), 'package.json')).resolve.paths('') ?? []
    const storeNm = join(storeDir(), 'node_modules')
    // The junction's chain stops at the anchor; only the realpath's continues into
    // the store, where dsh's own dependencies live. `hostPackageDir` realpaths for
    // exactly this reason — and `resolveModule`'s `from` branch realpaths too, so
    // the difference is invisible from a caller passing a junction in.
    expect(fromLink).not.toContain(storeNm)
    expect(fromReal).toContain(storeNm)
  })

  it('searches the install chain before the profile, and the profile before the home', () => {
    const roots = moduleSearchRoots(ctx(), 'p')
    expect(roots[0]?.root).toBe('host')
    expect(roots.map(r => r.dir)).toContain(join(storeDir(), 'node_modules'))
    expect(roots.slice(-3)).toEqual([
      { root: 'profile', dir: join(home(), 'profiles', 'p', 'node_modules') },
      { root: 'host-fallback', dir: join(home(), 'profiles', 'node_modules') },
      { root: 'home', dir: join(home(), 'node_modules') },
    ])
  })
})
