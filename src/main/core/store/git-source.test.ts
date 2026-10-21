/**
 * The multi-forge source parser. These cases are the contract the install view,
 * the store's origin tracking and the update checker all read a source through,
 * so they pin behaviour rather than implementation: which forge a spec names,
 * what package name it is expected to install as, and which strings must be
 * refused instead of handed to pnpm.
 */
import { describe, expect, it } from 'vitest'
import { FORGES, forgeForHost, installNameFor, parseSource } from './git-source.ts'
import { sourceKindOf } from './sources.ts'

describe('parseSource — npm', () => {
  it('reads a bare, versioned and scoped name', () => {
    expect(parseSource('pkg')).toEqual({ kind: 'npm', name: 'pkg' })
    expect(parseSource('pkg@1.2.3')).toEqual({ kind: 'npm', name: 'pkg' })
    expect(parseSource('@scope/pkg')).toEqual({ kind: 'npm', name: '@scope/pkg' })
    expect(parseSource('@scope/pkg@^2')).toEqual({ kind: 'npm', name: '@scope/pkg' })
  })

  it('keeps a range/tag in the kind but drops it from the name', () => {
    expect(parseSource('pkg@latest').name).toBe('pkg')
  })
})

describe('parseSource — forge shorthands', () => {
  it('recognises every forge the launcher names', () => {
    expect(parseSource('github:o/r')).toMatchObject({ kind: 'github', repo: 'o/r', name: 'r', host: 'github.com' })
    expect(parseSource('gitlab:g/p')).toMatchObject({ kind: 'gitlab', repo: 'g/p', name: 'p', host: 'gitlab.com' })
    expect(parseSource('gitea:o/r')).toMatchObject({ kind: 'gitea', repo: 'o/r', name: 'r', host: 'gitea.com' })
    expect(parseSource('gitee:o/r')).toMatchObject({ kind: 'gitee', repo: 'o/r', name: 'r', host: 'gitee.com' })
  })

  it('keeps a GitLab subgroup in the repo and archives by the project tail', () => {
    // `group/sub/project` is a real GitLab path; the package name is the tail.
    expect(parseSource('gitlab:group/sub/project')).toMatchObject({ kind: 'gitlab', repo: 'group/sub/project', name: 'project' })
  })

  it('is case-insensitive about the forge prefix', () => {
    expect(parseSource('GitLab:g/p').kind).toBe('gitlab')
  })

  it('carries a pinned ref and a subdirectory', () => {
    expect(parseSource('gitee:o/r#v1.2.3')).toMatchObject({ kind: 'gitee', name: 'r', ref: 'v1.2.3' })
    expect(parseSource('github:o/r#path:/packages/thing')).toMatchObject({ repo: 'o/r', subpath: 'packages/thing' })
  })

  it('refuses a traversal subpath instead of building one', () => {
    // The subpath becomes a pnpm `#path:` argument; `..` would escape the repo.
    expect(parseSource('github:o/r#path:/../../etc').subpath).toBeUndefined()
  })

  it('names no repository when the shorthand is incomplete', () => {
    const parsed = parseSource('github:owner')
    expect(parsed).toEqual({ kind: 'github' })
    expect(parsed.name).toBeUndefined()
  })
})

describe('parseSource — git URLs', () => {
  it('recognises a forge from the host, whatever the transport', () => {
    for (const spec of [
      'git+https://github.com/o/r.git',
      'https://github.com/o/r',
      'git+ssh://git@github.com/o/r.git',
      'git://github.com/o/r.git',
      'git@github.com:o/r.git',
    ]) {
      expect(parseSource(spec), spec).toMatchObject({ kind: 'github', repo: 'o/r', name: 'r' })
    }
  })

  it('covers every named forge by hostname', () => {
    expect(parseSource('https://gitlab.com/g/p.git').kind).toBe('gitlab')
    expect(parseSource('https://gitea.com/o/r.git').kind).toBe('gitea')
    expect(parseSource('https://gitee.com/o/r.git').kind).toBe('gitee')
  })

  it('treats a self-hosted named instance as that forge', () => {
    expect(parseSource('https://gitlab.example.com/g/p.git').kind).toBe('gitlab')
    expect(parseSource('https://gitea.internal/o/r.git').kind).toBe('gitea')
  })

  it('falls back to plain git for a host it cannot name', () => {
    // Still installable — pnpm is handed the URL as-is; only the label differs.
    expect(parseSource('https://git.example.dev/a/b.git')).toMatchObject({ kind: 'git', repo: 'a/b', name: 'b', host: 'git.example.dev' })
  })

  it('drops a port from the host', () => {
    expect(parseSource('https://gitlab.example.com:8443/g/p.git').host).toBe('gitlab.example.com')
  })

  it('is unknown for a URL naming no repository', () => {
    expect(parseSource('https://github.com/o').name).toBeUndefined()
  })
})

describe('parseSource — owner/repo shorthand and local paths', () => {
  it('reads a bare owner/repo as a github repo', () => {
    expect(parseSource('o/r')).toMatchObject({ kind: 'github', repo: 'o/r', name: 'r' })
  })

  it('reads file: and absolute paths as local', () => {
    expect(parseSource('file:/tmp/plugin')).toMatchObject({ kind: 'local', name: 'plugin' })
    expect(parseSource('C:\\plugins\\thing')).toMatchObject({ kind: 'local', name: 'thing' })
  })

  it('is unknown for junk', () => {
    expect(parseSource('').kind).toBe('unknown')
    expect(parseSource('   ').kind).toBe('unknown')
    expect(parseSource('not a spec!').kind).toBe('unknown')
  })
})

describe('forgeForHost', () => {
  it('matches an exact host and a self-hosted instance', () => {
    expect(forgeForHost('github.com')).toBe('github')
    expect(forgeForHost('GitLab.com')).toBe('gitlab')
    expect(forgeForHost('gitlab.corp.cn')).toBe('gitlab')
  })
  it('is undefined for an unnamed host', () => {
    expect(forgeForHost('example.dev')).toBeUndefined()
  })
  it('names every forge exactly once', () => {
    const ids = FORGES.map(f => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('installNameFor', () => {
  it('agrees with the parser about the name', () => {
    expect(installNameFor('gitee:o/my-plugin')).toBe('my-plugin')
    expect(installNameFor('@scope/pkg@1.0.0')).toBe('@scope/pkg')
    expect(installNameFor('https://gitlab.com/g/p.git')).toBe('p')
  })

  it('is undefined when the source names no package', () => {
    expect(installNameFor('github:owner')).toBeUndefined()
  })
})

describe('sourceKindOf', () => {
  it('keeps each forge distinct instead of collapsing to github', () => {
    expect(sourceKindOf('github:o/r')).toBe('github')
    expect(sourceKindOf('gitlab:g/p')).toBe('gitlab')
    expect(sourceKindOf('gitea:o/r')).toBe('gitea')
    expect(sourceKindOf('gitee:o/r')).toBe('gitee')
  })

  it('labels an unnamed git host as github, the origin it is closest to', () => {
    // Recorded origins predate the forge split; a plain git URL has no better home.
    expect(sourceKindOf('git+https://git.example.dev/a/b.git')).toBe('github')
  })

  it('still classifies npm and local sources', () => {
    expect(sourceKindOf('pkg@1.0.0')).toBe('npm')
    expect(sourceKindOf('@scope/pkg')).toBe('npm')
    expect(sourceKindOf('file:/tmp/x')).toBe('local')
  })
})
