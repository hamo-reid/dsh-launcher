/**
 * Installed-plugin overview: `dirUniqueBytes` size statistics (hard-link dedupe,
 * symlink/junction skip) and the provenance classification
 * (official / store / local-link / external / sub-bundle).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirUniqueBytes, buildInstalledOverview } from './store-overview.ts'
import type { DshScope } from './appState.ts'

let root: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-size-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('dirUniqueBytes', () => {
  it('sums distinct files, counting a hard-linked copy once', () => {
    const dir = join(root, 'a')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'x.bin'), Buffer.alloc(4096, 1))
    writeFileSync(join(dir, 'y.bin'), Buffer.alloc(2048, 2))
    // Same inode as x.bin under another name.
    linkSync(join(dir, 'x.bin'), join(dir, 'x-link.bin'))
    writeFileSync(join(dir, 'sub.txt'), 'hello') // 5 bytes, nested
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 's.bin'), Buffer.alloc(1000, 3))
    expect(dirUniqueBytes(dir)).toBe(4096 + 2048 + 5 + 1000)
  })

  it('skips symlink/junction entries (their real file lives elsewhere)', () => {
    const outer = join(root, 'outer')
    const inner = join(root, 'inner')
    mkdirSync(outer, { recursive: true })
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(outer, 'o.bin'), Buffer.alloc(512, 9))
    writeFileSync(join(inner, 'i.bin'), Buffer.alloc(2048, 7))
    try {
      // dir symlink inside outer → its target (inner) is NOT part of outer's size.
      symlinkSync(inner, join(outer, 'ln'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch { /* junction may need perms — then we already covered the core path */ }
    expect(dirUniqueBytes(outer)).toBe(512)
  })

  it('handles a missing dir as zero', () => {
    expect(dirUniqueBytes(join(root, 'nope'))).toBe(0)
  })
})

describe('buildInstalledOverview provenance', () => {
  it('distinguishes official / store / local-link / external', () => {
    const base = mkdtempSync(join(tmpdir(), 'pm-overview-'))
    try {
      const home = join(base, 'home')
      const profileDir = join(home, 'profiles', 'alpha')
      const nm = join(profileDir, 'node_modules')
      const store = join(base, 'store')
      const storePkg = join(store, 'archive', 'storeplug', '1.0.0', 'node_modules', 'storeplug')

      for (const p of [
        nm,
        join(nm, '@deepseek-ai', 'dsh-base'),
        join(nm, 'linkplug'),
        join(nm, 'extplug'),
        join(nm, 'storeplug'),
        join(nm, 'agg'),
        join(nm, 'subb'),
        storePkg,
      ]) mkdirSync(p, { recursive: true })

      const pkg = (name: string, version: string): string => JSON.stringify({ name, version })
      writeFileSync(join(nm, '@deepseek-ai', 'dsh-base', 'package.json'), pkg('@deepseek-ai/dsh-base', '0.1.0'))
      writeFileSync(join(nm, 'linkplug', 'package.json'), pkg('linkplug', '1.0.0'))
      writeFileSync(join(nm, 'extplug', 'package.json'), pkg('extplug', '2.0.0'))
      writeFileSync(join(nm, 'storeplug', 'package.json'), pkg('storeplug', '1.0.0'))
      writeFileSync(join(storePkg, 'package.json'), pkg('storeplug', '1.0.0'))
      // An aggregate bundle whose patch references a sub-package.
      writeFileSync(join(nm, 'agg', 'package.json'), JSON.stringify({ name: 'agg', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
      writeFileSync(join(nm, 'agg', 'cordis.patch.yml'), '- id: sub-row\n  name: subb\n')
      writeFileSync(join(nm, 'subb', 'package.json'), pkg('subb', '1.0.0'))
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-alpha',
        dependencies: {
          '@deepseek-ai/dsh-base': '^0.1.0',
          linkplug: 'link:../linkplug',
          extplug: '^2.0.0',
          storeplug: `file:${storePkg}`,
        },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'storeplug', 'agg'] } },
      }))

      const dshes: DshScope[] = [{ id: 'd', name: 'dsh', version: '0.1.0', home }]
      const rows = buildInstalledOverview(dshes, store)
      const by = (n: string): typeof rows[number] | undefined => rows.find(r => r.name === n)

      expect(by('@deepseek-ai/dsh-base')?.provenances).toEqual(['official'])
      expect(by('@deepseek-ai/dsh-base')?.kind).toBe('template')
      expect(by('linkplug')?.provenances).toEqual(['local-link'])
      expect(by('extplug')?.provenances).toEqual(['external'])
      expect(by('storeplug')?.provenances).toEqual(['store'])
      expect(by('storeplug')?.kind).toBe('bundle')
      expect(by('subb')?.provenances).toEqual(['sub-bundle'])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})