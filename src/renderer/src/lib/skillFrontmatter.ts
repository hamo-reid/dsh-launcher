/**
 * The live frontmatter preview for the skill editor.
 *
 * This is deliberately NOT `core/skills/skills.ts`'s parser. That one is authoritative:
 * it runs YAML, types its values, and throws on anything it cannot accept — which
 * is right on save and useless while typing. This one runs on every keystroke over
 * text that is expected to be half-written, so it does the opposite: line-prefix
 * matching, no YAML types, and it NEVER throws. `name: 123` is a string here and a
 * rejected number there, and that difference is the point.
 *
 * What it answers is only "does this look like a skill header yet".
 */

/** The header fields the preview shows, both optional: absent means the fence or
 * the field is not (yet) there. */
export interface LiveHeader {
  name?: string
  description?: string
}

/** Read `name` / `description` out of a leading `---` fence, best effort.
 *
 * A fence that never closes, a missing field, or an empty value all read as
 * "nothing yet" rather than as an error — the editor is mid-typing, and the
 * authoritative answer comes from the save-time validation.
 *
 * The fence must sit at column 0, unindented, because `core/skills/skills.ts` requires
 * exactly that: a preview that accepted `  ---` would show a green header for a
 * file the save path then rejects, which is worse than showing nothing. */
export function liveHeader(text: string): LiveHeader {
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') return {}
  const end = lines.findIndex((line, i) => i > 0 && line === '---')
  if (end < 0) return {}
  const pick = (key: string): string | undefined => {
    const line = lines.slice(1, end).find(l => l.startsWith(`${key}:`))
    const value = line?.slice(key.length + 1).trim() ?? ''
    return value === '' ? undefined : value.replace(/^'(.*)'$/, '$1')
  }
  return { name: pick('name'), description: pick('description') }
}
