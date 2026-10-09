/**
 * The path-containment primitives: a question about directories, answered with
 * the platform's own path semantics rather than with string prefixes.
 *
 * The case-variant cases are gated on win32 because that is where they mean
 * "the same directory": on POSIX two spellings really are two directories, and
 * `relative` is right to say so.
 */
import { describe, expect, it } from 'vitest'
import { join, resolve, sep } from 'node:path'
import { pathOutsideRoot, pathWithin } from './name-guard.ts'

const root = resolve('/data/plugins')

describe('pathWithin', () => {
  it('counts the root itself and anything under it as inside', () => {
    expect(pathWithin(root, root)).toBe(true)
    expect(pathWithin(root, join(root, 'archive'))).toBe(true)
    expect(pathWithin(root, join(root, 'archive', 'pkg', '1.0.0', 'node_modules', 'pkg'))).toBe(true)
    expect(pathWithin(root, join(root, 'a', '..', 'b'))).toBe(true)
    expect(pathWithin(root, `${root}${sep}`)).toBe(true)
  })

  it('counts a climb out, a sibling, and another root as outside', () => {
    expect(pathWithin(root, join(root, '..'))).toBe(false)
    expect(pathWithin(root, join(root, '..', 'other'))).toBe(false)
    // A sibling whose NAME merely starts the same way is not a descendant.
    expect(pathWithin(root, `${root}-evil`)).toBe(false)
    expect(pathWithin(root, resolve('/tmp/elsewhere'))).toBe(false)
    // A child whose name begins with dots is still a child.
    expect(pathWithin(root, join(root, '..cache'))).toBe(true)
  })

  it.runIf(process.platform === 'win32')('uses the platform semantics: a differently-cased path is the SAME directory', () => {
    // The failure this closes: a spec's spelling comes from whenever the
    // manifest was written, the store setting from now. A prefix test called
    // these the same only when the bytes matched.
    expect(pathWithin('C:\\Data\\plugins', 'c:\\data\\plugins\\archive\\pkg\\1.0.0')).toBe(true)
    expect(pathWithin('C:\\Data\\plugins', 'C:\\DATA\\PLUGINS')).toBe(true)
    // And case folding must not swallow a genuine sibling.
    expect(pathWithin('C:\\Data\\plugins', 'c:\\data\\plugins-old\\x')).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('keeps case significant where the filesystem does', () => {
    expect(pathWithin('/data/plugins', '/Data/plugins/x')).toBe(false)
  })
})

describe('pathOutsideRoot', () => {
  it('is the exact negation, so the two can never drift', () => {
    const cases: [string, string][] = [
      [root, root],
      [root, join(root, 'a')],
      [root, `${root}-evil`],
      [root, join(root, '..')],
      [root, resolve('/tmp/elsewhere')],
    ]
    for (const [container, target] of cases) {
      expect(pathOutsideRoot(container, target), target).toBe(!pathWithin(container, target))
    }
  })
})
