/**
 * The install view's source label. These cases mirror `main/core/store/
 * git-source.ts`, which is what actually decides the install; this module only
 * *describes* the string, so a disagreement shows up here as a wrong label rather
 * than a wrong download. Kept in sync deliberately, and tested so it stays that way.
 */
import { describe, expect, it } from 'vitest'
import { sameSource, summarizeSource } from './pluginSource.ts'

describe('summarizeSource', () => {
  it('describes an npm name, with and without a version', () => {
    expect(summarizeSource('pkg')).toEqual({ kind: 'npm', name: 'pkg' })
    expect(summarizeSource('pkg@1.2.3')).toEqual({ kind: 'npm', name: 'pkg' })
    expect(summarizeSource('@scope/pkg@^2')).toEqual({ kind: 'npm', name: '@scope/pkg' })
  })

  it('describes each forge shorthand', () => {
    expect(summarizeSource('github:o/r')).toMatchObject({ kind: 'github', repo: 'o/r', name: 'r' })
    expect(summarizeSource('gitlab:g/p')).toMatchObject({ kind: 'gitlab', repo: 'g/p', name: 'p' })
    expect(summarizeSource('gitea:o/r')).toMatchObject({ kind: 'gitea', name: 'r' })
    expect(summarizeSource('gitee:o/r')).toMatchObject({ kind: 'gitee', name: 'r' })
  })

  it('keeps a GitLab subgroup, naming the project tail', () => {
    expect(summarizeSource('gitlab:group/sub/project')).toMatchObject({ kind: 'gitlab', repo: 'group/sub/project', name: 'project' })
  })

  it('names a half-typed shorthand but no package', () => {
    // The label says "this is a github spec" while the user is still typing;
    // there is no name to promise yet, so none is invented.
    expect(summarizeSource('github:owner')).toEqual({ kind: 'github' })
  })

  it('drops the .git suffix and shows the repo, not the transport', () => {
    expect(summarizeSource('git+https://github.com/o/r.git')).toMatchObject({ kind: 'github', repo: 'o/r', name: 'r', host: 'github.com' })
    expect(summarizeSource('git@gitlab.com:g/p.git')).toMatchObject({ kind: 'gitlab', repo: 'g/p' })
    expect(summarizeSource('git://gitee.com/o/r.git')).toMatchObject({ kind: 'gitee', repo: 'o/r' })
  })

  it('names a self-hosted instance after the forge it declares', () => {
    expect(summarizeSource('https://gitlab.corp.cn/g/p.git')).toMatchObject({ kind: 'gitlab', host: 'gitlab.corp.cn' })
  })

  it('shows an unnamed host as plain git, host included', () => {
    expect(summarizeSource('https://git.example.dev/a/b.git')).toMatchObject({ kind: 'git', repo: 'a/b', host: 'git.example.dev', name: 'b' })
  })

  it('carries a subdirectory', () => {
    expect(summarizeSource('github:o/r#path:/packages/thing')).toMatchObject({ repo: 'o/r', subpath: 'packages/thing' })
  })

  it('is silent for an empty draft or a URL naming no repo', () => {
    expect(summarizeSource('')).toBeNull()
    expect(summarizeSource('   ')).toBeNull()
    expect(summarizeSource('https://github.com/o')).toBeNull()
  })

  it('describes a local path', () => {
    expect(summarizeSource('file:/tmp/plugin')).toEqual({ kind: 'local', name: 'plugin' })
  })
})

describe('sameSource', () => {
  it('matches the same spec typed twice, ignoring case and spaces', () => {
    expect(sameSource('gitee:o/r', ' Gitee:O/R ')).toBe(true)
    expect(sameSource('@scope/pkg', '@scope/pkg')).toBe(true)
  })

  it('does not merge two genuinely different requests', () => {
    // pnpm treats these as different installs, so the guard must too.
    expect(sameSource('pkg', 'pkg@1.0.0')).toBe(false)
    expect(sameSource('gitee:o/r', 'gitee:o/r2')).toBe(false)
  })

  it('never matches two empty strings', () => {
    // Otherwise an untouched input would look like an in-flight download.
    expect(sameSource('', '')).toBe(false)
    expect(sameSource('  ', '')).toBe(false)
  })
})
