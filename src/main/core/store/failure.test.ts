/**
 * The failure classifier: what a person is told when a download fails.
 *
 * These cases use REAL pnpm output shapes (the ANSI-coloured blocks pnpm prints
 * for each error family), because the whole point of the module is to recognise
 * what pnpm actually says, not what we imagine it says. Each case pins the two
 * things a caller depends on: the kind (which decides the advice) and that the
 * offending detail survives into `params.detail` rather than being swallowed.
 */
import { describe, expect, it } from 'vitest'
import { cleanLog, diagnoseFailure, failureSummary, pnpmErrorCode } from './failure.ts'

/** Wrap text in the colour codes pnpm emits, so cleaning is exercised too. */
const ansi = (text: string): string => `\x1b[31m${text}\x1b[39m`

describe('cleanLog', () => {
  it('strips ANSI, carriage-return progress and blank lines', () => {
    // `\r` ends a progress line, so the text before it is real output and is kept;
    // the point is that the DOS-style line ending does not glue two lines together.
    const raw = '\x1b[2K\x1b[1G⠋ resolving\rdone\r\n\x1b[31mERR_PNPM_X\x1b[39m\n\n  tail  '
    expect(cleanLog(raw)).toEqual(['⠋ resolving', 'done', 'ERR_PNPM_X', '  tail'])
  })

  it('keeps indented detail readable but trims trailing space', () => {
    expect(cleanLog('│   at foo   ')).toEqual(['at foo'])
  })
})

describe('pnpmErrorCode', () => {
  it('takes the LAST code, which is the fatal one', () => {
    // pnpm prints a handled warning before the error that actually stopped it.
    const log = 'WARN ERR_PNPM_IGNORED_BUILDS\nERR_PNPM_NO_MATCHING_VERSION'
    expect(pnpmErrorCode(log)).toBe('ERR_PNPM_NO_MATCHING_VERSION')
  })

  it('is undefined when pnpm printed no code', () => {
    expect(pnpmErrorCode('some raw fetch failure')).toBeUndefined()
  })
})

describe('diagnoseFailure — registry', () => {
  it('recognises a 404 as a missing package, naming the spec', () => {
    const report = diagnoseFailure({
      log: ansi(' ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@deepseek-ai%2Fnope - Not Found - 404'),
      source: '@deepseek-ai/nope',
    })
    expect(report.kind).toBe('not-found')
    expect(report.params?.['detail']).toBe('@deepseek-ai/nope')
    // A scoped package gets the scope-specific advice as well.
    expect(report.advice).toContain('checkScope')
    expect(report.code).toBe('ERR_PNPM_FETCH_404')
  })

  it('recognises a missing version and names the version asked for', () => {
    const report = diagnoseFailure({
      log: 'ERR_PNPM_NO_MATCHING_VERSION  No matching version found for pkg@9.9.9.',
      source: 'pkg@9.9.9',
    })
    expect(report.kind).toBe('version')
    expect(report.params?.['detail']).toContain('pkg@9.9.9')
    expect(report.advice).toContain('useExactVersion')
  })

  it('recognises an integrity failure as a transport problem, not a bad package', () => {
    const report = diagnoseFailure({ log: 'ERR_PNPM_TARBALL_INTEGRITY  integrity checksum failed for pkg' })
    expect(report.kind).toBe('network')
    expect(report.advice).toContain('checkProxy')
  })
})

describe('diagnoseFailure — auth', () => {
  it('recognises a 401 from a registry', () => {
    const report = diagnoseFailure({ log: 'ERR_PNPM_FETCH_401  GET https://r.example/x: Unauthorized - 401' })
    expect(report.kind).toBe('auth')
    expect(report.advice).toEqual(expect.arrayContaining(['login', 'checkToken']))
  })

  it('recognises a 403 as "refused", suggesting read permission', () => {
    const report = diagnoseFailure({ log: 'ERR_PNPM_FETCH_403 Forbidden' })
    expect(report.kind).toBe('auth')
    expect(report.advice).toContain('checkPrivate')
  })

  it('recognises an SSH key rejection, which reads nothing like an HTTP error', () => {
    const report = diagnoseFailure({
      log: 'git@gitlab.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
    })
    expect(report.kind).toBe('auth')
    expect(report.advice).toContain('checkSsh')
  })

  it('recognises a missing host key', () => {
    expect(diagnoseFailure({ log: 'Host key verification failed.' }).kind).toBe('auth')
  })
})

describe('diagnoseFailure — network', () => {
  it('recognises DNS failure', () => {
    const report = diagnoseFailure({ log: 'request to https://r.example failed, reason: getaddrinfo ENOTFOUND r.example' })
    expect(report.kind).toBe('network')
    expect(report.advice).toContain('checkNetwork')
  })

  it('recognises a dropped or reset connection', () => {
    expect(diagnoseFailure({ log: 'read ECONNRESET' }).kind).toBe('network')
    expect(diagnoseFailure({ log: 'connect ETIMEDOUT 10.0.0.1:443' }).kind).toBe('network')
  })

  it('recognises a registry 5xx as "cannot reach", not "not found"', () => {
    const report = diagnoseFailure({ log: 'ERR_PNPM_META_FETCH_FAIL  GET https://r.example/pkg: 503 Service Unavailable' })
    expect(report.kind).toBe('network')
    expect(report.advice).toContain('retryLater')
  })
})

describe('diagnoseFailure — the source is not installable', () => {
  it('recognises a missing package.json in the repo/folder', () => {
    const report = diagnoseFailure({
      log: 'ERR_PNPM_READ_PKG  No package.json found in /tmp/x',
      source: 'github:o/not-a-plugin',
    })
    expect(report.kind).toBe('not-a-package')
    expect(report.advice).toContain('checkRepo')
  })

  it('recognises an invalid package name', () => {
    expect(diagnoseFailure({ log: 'ERR_PNPM_MISSING_PACKAGE_NAME Invalid package name "a b"' }).kind).toBe('not-a-package')
  })
})

describe('diagnoseFailure — the machine', () => {
  it('recognises a full disk', () => {
    expect(diagnoseFailure({ log: 'ENOSPC: no space left on device' }).kind).toBe('disk')
  })

  it('recognises a locked file, and does not confuse it with SSH', () => {
    const report = diagnoseFailure({ log: 'EPERM: operation not permitted, rename C:\\x' })
    expect(report.kind).toBe('disk')
    expect(report.advice).toContain('closeFiles')
  })

  it('recognises a failing install script', () => {
    const report = diagnoseFailure({
      log: 'gyp ERR! stack Error: not found: python\nELIFECYCLE  Command failed with exit code 1.',
    })
    expect(report.kind).toBe('script')
    expect(report.advice).toContain('checkScript')
  })
})

describe('diagnoseFailure — precedence and fallbacks', () => {
  it('prefers the specific cause when a log matches several families', () => {
    // A git auth failure over HTTP is ALSO a network error; the auth rule is the
    // one that tells the user something they can act on.
    const report = diagnoseFailure({
      log: 'ERR_PNPM_FETCH_401 Unauthorized\nrequest failed, reason: connect ECONNREFUSED',
    })
    expect(report.kind).toBe('auth')
  })

  it('treats a cancel as cancelled, whatever else the partial log says', () => {
    const report = diagnoseFailure({ log: 'ERR_PNPM_FETCH_404', aborted: true })
    expect(report.kind).toBe('aborted')
    expect(report.advice).toEqual([])
  })

  it('trusts a caller-supplied hint over any pattern', () => {
    // installSource verified the result: it knows the name did not match, even
    // though the log ends in a generic resolution error.
    const report = diagnoseFailure({
      log: 'ERR_PNPM_FETCH_404',
      hint: '来源实际安装的包名是 @scope/other',
    })
    expect(report.kind).toBe('name-mismatch')
    expect(report.headline).toContain('@scope/other')
    expect(report.advice).toEqual(expect.arrayContaining(['checkPackageJson', 'checkPath']))
  })

  it('falls back to unknown with the tail as evidence, never throwing', () => {
    const report = diagnoseFailure({ log: 'something entirely unexpected happened\nthen this', code: 1 })
    expect(report.kind).toBe('unknown')
    expect(report.evidence).toEqual(['something entirely unexpected happened', 'then this'])
    expect(report.advice).toContain('retryLater')
  })

  it('is unknown for an empty log rather than claiming a cause', () => {
    expect(diagnoseFailure({ log: '' }).kind).toBe('unknown')
  })

  it('evidence starts at the error line, not at the install chatter', () => {
    const report = diagnoseFailure({
      log: 'Progress: resolved 1, reused 0\nProgress: resolved 2, reused 0\nERR_PNPM_FETCH_404  GET /x - 404',
    })
    expect(report.evidence[0]).toBe('ERR_PNPM_FETCH_404  GET /x - 404')
  })
})

describe('failureSummary', () => {
  it('joins the headline to its detail', () => {
    const report = diagnoseFailure({ log: 'ERR_PNPM_FETCH_404  pkg - 404', source: 'pkg' })
    expect(failureSummary(report)).toBe(`找不到这个包：pkg`)
  })

  it('is just the headline when there is no detail', () => {
    expect(failureSummary(diagnoseFailure({ log: '', aborted: true }))).toBe('已取消')
  })
})
