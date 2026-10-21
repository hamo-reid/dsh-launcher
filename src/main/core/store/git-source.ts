/**
 * Recognizing where a plugin source comes from, across git hosts.
 *
 * A source can be typed by the user (the install view) or derived (the market
 * catalog, a dev snapshot). It is one of:
 *   - an npm spec              `name`, `name@ver`, `@scope/name@ver`
 *   - a git shorthand          `github:owner/repo`, `gitlab:group/project`,
 *                              `gitea:owner/repo`, `gitee:owner/repo`
 *   - a git URL                `git+https://host/o/r.git`, `git+ssh://…`,
 *                              `https://host/o/r`, `git://…`, `ssh://…`
 *   - a local path             `file:…` / an absolute folder
 *
 * Everything below is pure: no network, no filesystem. pnpm does the actual
 * fetching, so the only job here is to classify a spec, guess the package name
 * it will install as (a hint that `installSource` re-verifies against
 * `node_modules`), and recognise the same spec typed twice.
 *
 * The hosts are data, not branches: GitHub, GitLab, Gitea and Gitee all serve
 * the same `owner/repo` shape, so one parser covers them and an unrecognised
 * host is still a git source rather than a rejection.
 */

/** A git host the launcher can name in a shorthand spec. */
export interface Forge {
  /** The shorthand prefix, e.g. `gitlab`. */
  id: 'github' | 'gitlab' | 'gitea' | 'gitee'
  /** Hostname used to recognise a URL form of the same forge. */
  host: string
}

/** The shorthands the UI offers, in the order it lists them. */
export const FORGES: readonly Forge[] = [
  { id: 'github', host: 'github.com' },
  { id: 'gitlab', host: 'gitlab.com' },
  { id: 'gitea', host: 'gitea.com' },
  { id: 'gitee', host: 'gitee.com' },
]

/** A parsed source. `kind` is what the store records as the origin. */
export interface ParsedSource {
  /** `npm` | a forge id | `git` (a git URL on a host we do not name) | `local` | `unknown`. */
  kind: 'npm' | 'github' | 'gitlab' | 'gitea' | 'gitee' | 'git' | 'local' | 'unknown'
  /** The package name the source is expected to install as, when derivable. */
  name?: string
  /** The git repository's `owner/repo` (or the project path), when derivable. */
  repo?: string
  /** The hostname of a git source, when derivable. */
  host?: string
  /** A subdirectory inside the repo (`#path:/sub`), when derivable. */
  subpath?: string
  /** The ref/branch/commit pinned in the spec, when derivable. */
  ref?: string
}

/** The shorthands pnpm understands, which we also accept as a source. */
const SHORTHAND = new Set<string>(FORGES.map(f => f.id))

/** A package name pnpm would accept as a bare registry spec. */
const NPM_SPEC = /^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+(@[A-Za-z0-9._~^*<>=|-]+)?$/

/** A repo path segment that is safe to turn into an install name hint. */
function safeName(seg: string): string | undefined {
  const cleaned = seg.replace(/\.git$/i, '').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return undefined
  // The hint becomes a path segment under archive/<name>/, so refuse separators.
  if (/[\\/]/.test(cleaned)) return undefined
  return cleaned
}

/** Strip the git transport prefixes so one URL parser handles every form.
 * `git+https://…` and `git://host/…` both carry a real protocol after the
 * marker, so only a bare `git:` (pnpm's shorthand, as in `git:host:o/r`) is
 * dropped — cutting `git://` down to `//` would lose the host. */
function stripGitPrefix(spec: string): { body: string; wasGit: boolean } {
  if (/^git\+/i.test(spec)) return { body: spec.slice(4), wasGit: true }
  if (/^git:(?!\/\/)/i.test(spec)) return { body: spec.slice(4), wasGit: true }
  if (/^git:\/\//i.test(spec)) return { body: spec, wasGit: true }
  return { body: spec, wasGit: false }
}

/** `#path:/sub` and `#ref` tails. Returns the bare body plus the parts. */
function splitFragment(body: string): { bare: string; ref?: string; subpath?: string } {
  const hash = body.indexOf('#')
  if (hash < 0) return { bare: body }
  const bare = body.slice(0, hash)
  const fragment = body.slice(hash + 1)
  if (fragment === '') return { bare }
  const pathAt = /^path:(.*)$/i.exec(fragment)
  if (pathAt !== null) {
    const subpath = (pathAt[1] ?? '').replace(/^\/+|\/+$/g, '')
    // Reject traversal: a subpath escapes the repo tree otherwise.
    const escaped = subpath.split('/').some(seg => seg === '..')
    if (subpath !== '' && !escaped) return { bare, subpath }
    return { bare }
  }
  return { bare, ref: fragment }
}

/** The forge a hostname belongs to, or `undefined` for an unnamed host. */
export function forgeForHost(host: string): Forge['id'] | undefined {
  const lower = host.toLowerCase()
  const exact = FORGES.find(f => f.host === lower)
  if (exact !== undefined) return exact.id
  // Self-hosted instances (`gitlab.example.com`, `git.company.cn`) declare
  // themselves in the hostname; trust that before falling back to plain `git`.
  const named = FORGES.find(f => lower === `${f.id}.com` || lower.startsWith(`${f.id}.`) || lower.startsWith(`${f.id}-`))
  return named?.id
}

/**
 * Parse a user-typed or catalog-derived source.
 *
 * Never throws and never rejects: an unrecognised string is returned as
 * `unknown` so the caller can decide (the install view refuses it up front with
 * a message, while a store install lets pnpm produce the real error).
 */
export function parseSource(raw: string): ParsedSource {
  const spec = raw.trim()
  if (spec === '') return { kind: 'unknown' }

  // ── local paths ────────────────────────────────────────────────────────────
  if (/^file:/i.test(spec)) {
    const name = safeName(spec.replace(/^file:/i, '').split(/[\\/]/).filter(s => s !== '').pop() ?? '')
    return { kind: 'local', ...(name !== undefined ? { name } : {}) }
  }
  if (/^([A-Za-z]:[\\/]|\\\\|\/)/.test(spec)) {
    const name = safeName(spec.split(/[\\/]/).filter(s => s !== '').pop() ?? '')
    return { kind: 'local', ...(name !== undefined ? { name } : {}) }
  }

  // ── forge shorthands: github:o/r, gitlab:g/p, gitea:o/r, gitee:o/r ─────────
  const shorthand = /^([A-Za-z]+):(.+)$/.exec(spec)
  if (shorthand !== null && SHORTHAND.has(shorthand[1].toLowerCase())) {
    const forge = shorthand[1].toLowerCase() as Forge['id']
    const { bare, ref, subpath } = splitFragment(shorthand[2])
    // `owner/repo`, optionally nested (GitLab subgroups: `group/sub/project`).
    const segments = bare.replace(/^\/+|\/+$/g, '').split('/').filter(s => s !== '')
    if (segments.length < 2) {
      // `github:owner` names no repository — not installable.
      return { kind: forge }
    }
    const repo = segments.join('/')
    const name = safeName(segments[segments.length - 1])
    const host = FORGES.find(f => f.id === forge)?.host
    return {
      kind: forge,
      repo,
      ...(host !== undefined ? { host } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(ref !== undefined ? { ref } : {}),
      ...(subpath !== undefined ? { subpath } : {}),
    }
  }

  // `owner/repo` — pnpm's own GitHub shorthand, and what a copied web URL often
  // reduces to. Only when no git markers are present (an npm scope has `@`).
  if (!spec.includes('@') && !spec.includes(':') && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(spec)) {
    const repo = spec.split('/')[1] ?? ''
    const name = safeName(repo)
    return { kind: 'github', repo: spec, host: 'github.com', ...(name !== undefined ? { name } : {}) }
  }

  // ── git URLs ───────────────────────────────────────────────────────────────
  const { body: stripped, wasGit } = stripGitPrefix(spec)
  const looksGitUrl = wasGit || /^(https?|ssh|git|ftp):\/\//i.test(stripped) || /^[\w.-]+@[\w.-]+:/.test(stripped)
  if (!wasGit && !looksGitUrl) {
    // ── npm registry spec ────────────────────────────────────────────────────
    if (NPM_SPEC.test(spec)) {
      // `@scope/name@ver` → `@scope/name`; `name@ver` → `name`. Split on the LAST
      // `@` so a leading scope marker is never mistaken for the version separator.
      const at = spec.lastIndexOf('@')
      const nameOnly = at > 0 ? spec.slice(0, at) : spec
      return nameOnly === '' ? { kind: 'unknown' } : { kind: 'npm', name: nameOnly }
    }
    return { kind: 'unknown' }
  }

  return parseGitUrl(stripped)
}

/** Parse an SCP-style or URL git remote (`git@host:o/r.git`, `https://host/o/r`). */
function parseGitUrl(body: string): ParsedSource {
  const { bare, ref, subpath } = splitFragment(body)
  let host: string | undefined
  let path = ''

  const scp = /^(?:[^@/]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(bare)
  if (scp !== null && !/^\w+:\/\//.test(bare)) {
    host = scp[1]
    path = scp[2] ?? ''
  } else {
    const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)(\/.*)?$/.exec(bare)
    if (m === null) return { kind: 'unknown' }
    host = (m[1] ?? '').replace(/:\d+$/, '')
    path = m[2] ?? ''
  }

  const segments = path.replace(/^\/+|\/+$/g, '').split('/').filter(s => s !== '')
  // A forge URL may carry `/tree/<ref>/<sub>` or `/src/branch/<ref>/…` tails; the
  // repo itself is always the first two segments for the forges we name.
  const forge = host !== undefined ? forgeForHost(host) : undefined
  // `.git` is a transport suffix, not part of the repo path: an update check
  // builds `api/<host>/repos/<repo>` from this, and `o/r.git` would 404.
  const repoSegments = segments.slice(0, 2).map(seg => seg.replace(/\.git$/i, ''))
  if (repoSegments.length < 2 || repoSegments.some(s => s === '')) {
    // A bare host URL names no repository.
    return { kind: forge ?? 'git', ...(host !== undefined ? { host } : {}) }
  }
  const repo = repoSegments.join('/')
  const name = safeName(repoSegments[1] ?? '')
  return {
    kind: forge ?? 'git',
    repo,
    ...(host !== undefined ? { host } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(subpath !== undefined ? { subpath } : {}),
  }
}

/** The package name a source is expected to install as, or `undefined` when it
 * cannot be guessed (an npm scope with no name, a bare host URL, `file:` dirs). */
export function installNameFor(source: string): string | undefined {
  return parseSource(source).name
}
