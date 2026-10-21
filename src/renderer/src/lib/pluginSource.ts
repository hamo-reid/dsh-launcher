/**
 * How the install view describes a source the user typed, before anything is
 * downloaded.
 *
 * Deliberately a *renderer* module and not a call into the main process: the
 * classification has to answer on every keystroke, and round-tripping IPC per
 * character would be absurd. It therefore duplicates the shape recognition of
 * `main/core/store/git-source.ts` — kept to the same rules, and unit-tested
 * against the same cases, so the two cannot drift silently about what a string
 * is. Anything this file cannot name returns null and stays quiet rather than
 * guessing wrongly.
 */

/** A parsed source, as far as a label needs to know. */
export interface SourceSummary {
  /** Which kind of source this reads as, for the label. */
  kind: 'npm' | 'github' | 'gitlab' | 'gitea' | 'gitee' | 'git' | 'local'
  /** The package name we expect it to install as, when derivable. */
  name?: string
  /** The repository path (`owner/repo`), when derivable. */
  repo?: string
  /** The host, when the source is a git URL. */
  host?: string
  /** A subdirectory inside the repo, when the spec pins one. */
  subpath?: string
}

const FORGE_IDS = ['github', 'gitlab', 'gitea', 'gitee'] as const

/** Strip `.git` and refuse a repo segment that could not be a package name. */
function bareName(seg: string): string | undefined {
  const cleaned = seg.replace(/\.git$/i, '').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..' || /[\\/]/.test(cleaned)) return undefined
  return cleaned
}

/** Split `#path:/sub` / `#ref` off a spec. */
function fragmentOf(body: string): { bare: string; subpath?: string } {
  const hash = body.indexOf('#')
  if (hash < 0) return { bare: body }
  const pathAt = /^path:(.*)$/i.exec(body.slice(hash + 1))
  const subpath = pathAt?.[1]?.replace(/^\/+|\/+$/g, '')
  if (subpath === undefined || subpath === '' || subpath.split('/').includes('..')) return { bare: body.slice(0, hash) }
  return { bare: body.slice(0, hash), subpath }
}

/** The forge a hostname belongs to, or undefined for an unnamed host. */
function forgeOf(host: string): SourceSummary['kind'] | undefined {
  const lower = host.toLowerCase()
  const exact = FORGE_IDS.find(id => `${id}.com` === lower)
  if (exact !== undefined) return exact
  return FORGE_IDS.find(id => lower.startsWith(`${id}.`) || lower.startsWith(`${id}-`))
}

/**
 * Describe what a typed source looks like, or `null` when it is nothing we can
 * name (an empty draft, a half-typed spec, a bare host URL). Pure.
 */
export function summarizeSource(raw: string): SourceSummary | null {
  const spec = raw.trim()
  if (spec === '') return null

  if (/^file:/i.test(spec) || /^([A-Za-z]:[\\/]|\\\\|\/)/.test(spec)) {
    const name = bareName(spec.split(/[\\/]/).filter(s => s !== '').pop() ?? '')
    return { kind: 'local', ...(name !== undefined ? { name } : {}) }
  }

  const shorthand = /^([A-Za-z]+):([^:].*)$/.exec(spec)
  if (shorthand !== null && (FORGE_IDS as readonly string[]).includes(shorthand[1].toLowerCase())) {
    const kind = shorthand[1].toLowerCase() as SourceSummary['kind']
    const { bare, subpath } = fragmentOf(shorthand[2])
    const segments = bare.replace(/^\/+|\/+$/g, '').split('/').filter(s => s !== '')
    if (segments.length < 2) return { kind }
    const name = bareName(segments[segments.length - 1] ?? '')
    return { kind, repo: segments.join('/'), ...(name !== undefined ? { name } : {}), ...(subpath !== undefined ? { subpath } : {}) }
  }

  const gitLike = /^(git\+|git:)/i.test(spec) || /^(https?|ssh|git|ftp):\/\//i.test(spec) || /^[\w.-]+@[\w.-]+:/.test(spec)
  if (!gitLike) {
    if (spec.includes(':')) return null
    const at = spec.lastIndexOf('@')
    const name = (at > 0 ? spec.slice(0, at) : spec).trim()
    if (name === '' || /^@[^/]+$/.test(name)) return null
    return { kind: 'npm', name }
  }

  const stripped = spec.replace(/^git\+/i, '').replace(/^git:(?!\/\/)/i, '')
  const { bare, subpath } = fragmentOf(stripped)
  const scp = !/^\w+:\/\//.test(bare) ? /^(?:[^@/]+@)?([\w.-]+):(.+)$/.exec(bare) : null
  const url = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)(\/.*)?$/.exec(bare)
  const host = scp !== null ? scp[1] : url?.[1]?.replace(/:\d+$/, '')
  const path = scp !== null ? scp[2] ?? '' : url?.[2] ?? ''
  const segments = path.replace(/^\/+|\/+$/g, '').split('/').filter(s => s !== '')
  if (host === undefined || segments.length < 2) return null
  // `.git` is a transport suffix, not the repo name — the label must not show it.
  const repo = segments.slice(0, 2).map(seg => seg.replace(/\.git$/i, '')).join('/')
  if (repo.split('/').some(seg => seg === '')) return null
  const name = bareName(segments[1] ?? '')
  const kind = forgeOf(host) ?? 'git'
  return { kind, repo, host, ...(name !== undefined ? { name } : {}), ...(subpath !== undefined ? { subpath } : {}) }
}

/**
 * Whether two specs name the same download. pnpm treats `pkg`, `pkg@latest` and
 * `pkg@^1` as different requests on purpose, so this is deliberately a STRING
 * comparison (trimmed, case-insensitive) rather than a semantic one: the guard
 * exists to stop the same click twice, not to normalise semver.
 */
export function sameSource(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().toLowerCase()
  return norm(a) === norm(b) && norm(a) !== ''
}
