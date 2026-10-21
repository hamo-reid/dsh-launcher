/**
 * Reading a failed download: what actually went wrong, and what to do about it.
 *
 * A plugin install fails in a handful of recurring ways — the package is not on
 * the registry, the git remote needs credentials, the host is offline, the name
 * points at something that is not a package — and pnpm reports all of them as a
 * wall of ANSI-coloured output ending in `ERR_PNPM_*` or a raw fetch error. That
 * wall is evidence, not an explanation, so it is kept whole for the detail view
 * but never used as the message a person reads first.
 *
 * Everything here is pure and pattern-based: no network, no filesystem, no
 * inference beyond what pnpm literally printed. The rules are ordered most
 * specific first, because several patterns legitimately appear in one log (a
 * git auth failure is also a network error) and the specific one is the answer.
 */

/** What kind of failure this is — decides the icon and the headline. */
export type FailureKind =
  | 'not-found' | 'auth' | 'network' | 'not-a-package' | 'name-mismatch'
  | 'version' | 'peer' | 'disk' | 'script' | 'aborted' | 'unknown'

/** A failure read out of pnpm's output. */
export interface FailureReport {
  kind: FailureKind
  /** The one line worth reading first: what happened, in the user's language
   * once the renderer localizes it (`download.cause.<kind>`). */
  headline: string
  /** i18n key for `headline`, so the renderer can localize without re-parsing. */
  headlineKey: string
  /** The exact pnpm lines that led to this verdict — the evidence, kept verbatim
   * so a report can still be acted on when the rule below is a guess. */
  evidence: string[]
  /** Concrete next steps, most-likely-fix first. Keys, not sentences. */
  advice: AdviceKey[]
  /** i18n interpolation for the headline (`{{detail}}`). */
  params?: Record<string, string>
  /** pnpm's own error identifier (`ERR_PNPM_…`), when present. */
  code?: string
}

export type AdviceKey =
  | 'checkName'
  | 'checkSpelling'
  | 'checkScope'
  | 'login'
  | 'checkSsh'
  | 'configureGit'
  | 'checkToken'
  | 'checkProxy'
  | 'checkNetwork'
  | 'retryLater'
  | 'checkPackageJson'
  | 'checkPrivate'
  | 'checkPath'
  | 'checkRepo'
  | 'useExactVersion'
  | 'checkNodeVersion'
  | 'freeSpace'
  | 'checkPermission'
  | 'closeFiles'
  | 'checkScript'
  | 'installBuildTools'

/** Everything the rules need, without the session's transport concerns. */
export interface FailureInput {
  /** The combined pnpm output (ANSI codes tolerated). */
  log: string
  /** The spec the user asked for. */
  source?: string
  /** The package name the launcher derived from the source, when known. */
  name?: string
  /** A message composed by the caller that already knows the cause (e.g.
   * `installSource`'s post-add checks) — tried before the log rules. */
  hint?: string
  /** Exit code, when known. */
  code?: number
  /** True when the run was cancelled rather than failing. */
  aborted?: boolean
}

/** Strip ANSI, carriage-return progress spam and trailing whitespace per line. */
export function cleanLog(raw: string): string[] {
  return raw
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/^\s*[│|]\s*/, '').trimEnd())
    .filter(line => line.trim() !== '')
}

/** pnpm's error identifier, when it printed one. The last one wins: pnpm echoes
 * earlier (handled) errors before the fatal one. The code's tail is alphanumeric
 * (`ERR_PNPM_FETCH_404`), so the match must include digits — a bare `[A-Z_]+`
 * silently truncates every code to `ERR_PNPM_FETCH_`. */
export function pnpmErrorCode(log: string): string | undefined {
  const matches = [...cleanLog(log).join('\n').matchAll(/ERR_PNPM_[A-Z0-9_]+/g)]
  return matches.length === 0 ? undefined : matches[matches.length - 1][0]
}

/** The lines worth showing as evidence: pnpm's own error block, else the tail. */
function evidenceOf(lines: string[]): string[] {
  const at = lines.findIndex(line => /ERR_PNPM_|ERR_INVALID|Elifecycle|npm ERR!|error:/.test(line))
  if (at >= 0) return lines.slice(at, at + 8)
  return lines.slice(-6)
}

/** First line of the log matching `re`, trimmed of pnpm's noise prefix. */
function findLine(lines: string[], re: RegExp): string | undefined {
  for (const line of lines) {
    if (re.test(line)) return line.trim()
  }
  return undefined
}

/** The most specific advice list for a kind, de-duplicated and order-preserving. */
function advice(...keys: AdviceKey[]): AdviceKey[] {
  return [...new Set(keys)]
}

/**
 * Read a failure out of a log. Never throws; an unrecognised failure comes back
 * as `unknown` with the tail as evidence, because "we do not know" is a better
 * answer than a wrong guess dressed as one.
 */
export function diagnoseFailure(input: FailureInput): FailureReport {
  const lines = cleanLog(input.log)
  const code = pnpmErrorCode(input.log)
  const text = lines.join('\n')
  const evidence = evidenceOf(lines)
  const base = { evidence, ...(code !== undefined ? { code } : {}) }

  if (input.aborted === true) {
    return {
      kind: 'aborted', headlineKey: 'download.cause.aborted', headline: '已取消',
      advice: [], ...base,
    }
  }

  // A caller that already knows the cause (post-add verification) wins over any
  // pattern: it looked at the result, not at the text.
  if (input.hint !== undefined && input.hint !== '') {
    return { kind: 'name-mismatch', headlineKey: 'download.cause.hint', headline: input.hint, advice: advice('checkPackageJson', 'checkPath'), ...base }
  }

  // ── not found: the registry / remote has no such package ────────────────────
  if (/E404|ERR_PNPM_FETCH_404|404 Not Found/i.test(text)) {
    return {
      kind: 'not-found', headlineKey: 'download.cause.notFound', headline: '找不到这个包',
      advice: advice('checkName', 'checkSpelling', ...(input.source?.startsWith('@') === true ? ['checkScope' as const] : [])),
      params: { detail: input.source ?? input.name ?? '' }, ...base,
    }
  }
  if (/ERR_PNPM_NO_MATCHING_VERSION/i.test(text)) {
    // The version comes straight from pnpm's sentence, so it is exactly what the
    // user asked for — stopping at the first space or dot would report `pkg@9`.
    const want = /No matching version found for (\S+?)[.\s]*(?:$|\n|instead)/i.exec(text)?.[1] ?? input.source ?? ''
    return {
      kind: 'version', headlineKey: 'download.cause.noVersion', headline: '没有这个版本',
      advice: advice('useExactVersion', 'checkName'),
      params: { detail: want }, ...base,
    }
  }

  // ── authentication: the remote exists but will not talk to us ───────────────
  if (/ERR_PNPM_FETCH_401|E401|unauthorized|authentication failed/i.test(text)) {
    return {
      kind: 'auth', headlineKey: 'download.cause.auth', headline: '来源需要认证',
      advice: advice('login', 'checkToken', 'checkSsh'),
      params: { detail: findLine(lines, /40[13]|authentication|unauthorized/i) ?? '' }, ...base,
    }
  }
  if (/E403|ERR_PNPM_FETCH_403|forbidden/i.test(text)) {
    return {
      kind: 'auth', headlineKey: 'download.cause.forbidden', headline: '来源拒绝访问',
      advice: advice('login', 'checkToken', 'checkPrivate'),
      params: { detail: findLine(lines, /40[13]|forbidden/i) ?? '' }, ...base,
    }
  }
  // SSH over a git remote: the classic "no key / host not in known_hosts".
  if (/Permission denied \(publickey\)|Host key verification failed|Could not read from remote repository/i.test(text)) {
    return {
      kind: 'auth', headlineKey: 'download.cause.ssh', headline: 'SSH 凭据无效',
      advice: advice('checkSsh', 'configureGit'),
      params: { detail: findLine(lines, /Permission denied|Host key|Could not read/i) ?? '' }, ...base,
    }
  }

  // ── the name resolves, but not to something installable ─────────────────────
  if (/ERR_PNPM_MISSING_PACKAGE_NAME|Invalid package name|is not a valid package name/i.test(text)) {
    return {
      kind: 'not-a-package', headlineKey: 'download.cause.notAPackage', headline: '来源不是一个插件包',
      advice: advice('checkPackageJson', 'checkRepo', 'checkPath'),
      params: { detail: findLine(lines, /package name|Invalid package/i) ?? '' }, ...base,
    }
  }
  if (/No package\.json found|ERR_PNPM_READ_PKG|does not contain a package\.json/i.test(text)) {
    return {
      kind: 'not-a-package', headlineKey: 'download.cause.noManifest', headline: '来源里没有 package.json',
      advice: advice('checkRepo', 'checkPath'),
      params: { detail: input.source ?? '' }, ...base,
    }
  }
  if (/ERR_PNPM_TARBALL_INTEGRITY|integrity checksum failed|EINTEGRITY/i.test(text)) {
    return {
      kind: 'network', headlineKey: 'download.cause.integrity', headline: '下载内容校验失败',
      advice: advice('retryLater', 'checkProxy'),
      params: { detail: findLine(lines, /integrity/i) ?? '' }, ...base,
    }
  }

  // ── transport: offline, DNS, TLS, proxy ─────────────────────────────────────
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_5\d\d/i.test(text)) {
    return {
      kind: 'network', headlineKey: 'download.cause.network', headline: '连不上来源',
      advice: advice('checkNetwork', 'checkProxy', 'retryLater'),
      params: { detail: findLine(lines, /ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed|ERR_PNPM_FETCH_5\d\d/i) ?? '' }, ...base,
    }
  }
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|TLS|certificate/i.test(text)) {
    return {
      kind: 'network', headlineKey: 'download.cause.timeout', headline: '连接中断',
      advice: advice('checkProxy', 'checkNetwork', 'retryLater'),
      params: { detail: findLine(lines, /ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|certificate/i) ?? '' }, ...base,
    }
  }

  // ── peers: installs, but not runnable ───────────────────────────────────────
  if (/ERR_PNPM_PEER_DEP_ISSUES|unmet peer/i.test(text)) {
    return {
      kind: 'peer', headlineKey: 'download.cause.peer', headline: '依赖的 peer 版本不满足',
      advice: advice('checkNodeVersion', 'checkPackageJson'),
      params: { detail: findLine(lines, /peer/i) ?? '' }, ...base,
    }
  }

  // ── the machine said no ─────────────────────────────────────────────────────
  if (/ENOSPC|no space left/i.test(text)) {
    return {
      kind: 'disk', headlineKey: 'download.cause.noSpace', headline: '磁盘空间不足',
      advice: advice('freeSpace'), params: { detail: findLine(lines, /ENOSPC|no space left/i) ?? '' }, ...base,
    }
  }
  if (/EPERM|EACCES|EBUSY|operation not permitted|permission denied(?! \(publickey\))/i.test(text)) {
    return {
      kind: 'disk', headlineKey: 'download.cause.permission', headline: '文件被占用或没有权限',
      advice: advice('closeFiles', 'checkPermission'),
      params: { detail: findLine(lines, /EPERM|EACCES|EBUSY|not permitted/i) ?? '' }, ...base,
    }
  }
  if (/ELIFECYCLE|preinstall|postinstall|node-gyp|gyp ERR/i.test(text)) {
    return {
      kind: 'script', headlineKey: 'download.cause.script', headline: '安装脚本执行失败',
      advice: advice('checkScript', 'installBuildTools'),
      params: { detail: findLine(lines, /ELIFECYCLE|gyp|postinstall|preinstall/i) ?? '' }, ...base,
    }
  }

  // ── nothing matched ─────────────────────────────────────────────────────────
  return {
    kind: 'unknown', headlineKey: 'download.cause.unknown', headline: '下载失败',
    advice: advice('retryLater'),
    params: { detail: evidence[0] ?? `exit ${String(input.code ?? '?')}` }, ...base,
  }
}

/**
 * A one-line summary suitable for a row or a toast: the headline plus the most
 * specific detail line, never the log. Kept separate from `diagnoseFailure` so a
 * list can render cheaply without losing the report.
 */
export function failureSummary(report: FailureReport): string {
  const detail = report.params?.['detail'] ?? ''
  return detail === '' ? report.headline : `${report.headline}：${detail}`
}
