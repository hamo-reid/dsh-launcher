/**
 * Turning a declared MCP `env` / `headers` entry into the value a child would
 * actually receive, and quoting an argv element for a shell.
 *
 * `resolveJsExpr` is the notable one: it resolves the documented `!!js` shapes
 * textually and NEVER evaluates. Returning null is a real answer — the entry is
 * reported as unevaluated and simply not sent, because a silently wrong value
 * would surface later as a misleading 401.
 */

import { child } from './logger.ts'
import type { McpKV } from '../../shared/types.ts'

/**
 * Best-effort textual resolution of a `!!js` value — never evaluation.
 *
 * Handles what the documented use cases need (a bearer template, a bare
 * `process.env.X` reference, a plain quoted literal) and returns `null` for
 * anything that would require running code. A `null` result means the entry is
 * reported as unevaluated and simply not sent, which is strictly safer than
 * guessing: a silently wrong value would surface as a misleading 401.
 */
export function resolveJsExpr(expr: string, secrets: Record<string, string | undefined>): string | null {
  let text = expr.trim()
  // Strip one layer of wrapping: the template backticks, or the quotes
  // `renderJsValue` adds to a non-bare expression.
  const wrapped = /^`([\s\S]*)`$/.exec(text) ?? /^'([\s\S]*)'$/.exec(text) ?? /^"([\s\S]*)"$/.exec(text)
  if (wrapped !== null) text = wrapped[1] ?? ''
  const lookup = (name: string): string | undefined => secrets[name] ?? process.env[name]
  // Interpolations first — replacing a bare `process.env.X` before `${...}`
  // would leave a `${value}` for the next pass to rewrite again.
  text = text.replace(
    /\$\{\s*process\.env(?:\.([A-Za-z_]\w*)|\[\s*'([A-Za-z_]\w*)'\s*\])\s*\}/g,
    (match, dot: string | undefined, bracket: string | undefined) => lookup(dot ?? bracket ?? '') ?? match,
  )
  text = text.replace(/\$\{\s*([A-Za-z_]\w*)\s*\}/g, (match, name: string) => lookup(name) ?? match)
  text = text.replace(/process\.env\.([A-Za-z_]\w*)/g, (match, name: string) => lookup(name) ?? match)
  text = text.replace(
    /process\.env\[\s*(['"])([A-Za-z_]\w*)\1\s*\]/g,
    (match, _quote: string, name: string) => lookup(name) ?? match,
  )
  // Anything still expression-shaped means we would have to evaluate it.
  if (/\$\{|process\.env|[()]|=>/.test(text)) return null
  return text
}

/** Resolve an `env` / `headers` list into the values a child would actually
 * see. A name whose value cannot be determined is left OUT of `values` (writing
 * `''` would be a different thing than dsh's `undefined`) and reported in
 * `missing`, which the UI surfaces as a caveat rather than a failure. */
export function resolveKv(
  list: McpKV[] | undefined,
  secrets: Record<string, string | undefined>,
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {}
  const missing: string[] = []
  for (const entry of list ?? []) {
    const name = entry.name.trim()
    if (name === '') continue
    if (entry.mode === 'plain') {
      values[name] = entry.value ?? ''
      continue
    }
    if (entry.mode === 'env') {
      // dsh reads these from the launch environment, which is the launcher's
      // secret store layered over its own env — mirror that order.
      const value = secrets[name] ?? process.env[name]
      if (value === undefined) { missing.push(name); continue }
      values[name] = value
      continue
    }
    const resolved = resolveJsExpr(entry.value ?? '', secrets)
    if (resolved === null) { missing.push(name); continue }
    values[name] = resolved
  }
  return { values, missing }
}

/** Quote one argv element for `shell: true`. Node only joins the array with
 * spaces when a shell is involved — it never quotes for us — so an argument
 * containing a space would be split by `cmd.exe`. Best effort: `cmd.exe` has
 * no exact escaping (`%`, `!`, `^` all misbehave), and the command line is
 * author-written in the first place. */
export function quoteForShell(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg
}
