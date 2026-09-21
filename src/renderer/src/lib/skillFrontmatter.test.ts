/**
 * The skill editor's live preview.
 *
 * The property that matters most is the last block: this runs on every keystroke
 * over text that is expected to be half-written, so it must never throw — a
 * preview that blows up while you are typing is worse than no preview.
 */
import { describe, expect, it } from 'vitest'
import { liveHeader } from './skillFrontmatter.ts'

describe('liveHeader', () => {
  it('reads the two fields out of a closed fence', () => {
    expect(liveHeader('---\nname: my-skill\ndescription: does a thing\n---\nbody\n'))
      .toEqual({ name: 'my-skill', description: 'does a thing' })
  })

  it('reports nothing before the fence is written', () => {
    expect(liveHeader('')).toEqual({})
    expect(liveHeader('name: my-skill')).toEqual({})
  })

  it('does not accept an indented fence, because the save path will not', () => {
    // `core/skills.ts` splits on a `---` at column 0. A preview that accepted this
    // would show a valid-looking header for a file the save path then rejects.
    expect(liveHeader('  ---\nname: x\n---\n')).toEqual({})
    expect(liveHeader('---\nname: x\n  ---\n')).toEqual({})
  })

  it('reports nothing while the fence is still open', () => {
    expect(liveHeader('---\nname: my-skill\n')).toEqual({})
    expect(liveHeader('---\n')).toEqual({})
    expect(liveHeader('---')).toEqual({})
  })

  it('tolerates CRLF, since the file on disk may be either', () => {
    expect(liveHeader('---\r\nname: my-skill\r\n---\r\n')).toEqual({ name: 'my-skill' })
  })

  it('reads an empty field as absent rather than as an empty string', () => {
    expect(liveHeader('---\nname:\ndescription: x\n---\n')).toEqual({ description: 'x' })
    expect(liveHeader('---\nname:   \n---\n')).toEqual({})
  })

  it('unstrips a single-quoted value, as YAML would', () => {
    expect(liveHeader("---\nname: 'my-skill'\n---\n")?.name).toBe('my-skill')
  })

  it('keeps a value a YAML parser would have typed, because this is a preview', () => {
    expect(liveHeader('---\nname: 123\n---\n')?.name).toBe('123')
  })

  it('stops at the closing fence rather than reading the body', () => {
    expect(liveHeader('---\nname: a\n---\nname: b\n')).toEqual({ name: 'a' })
  })

  it('never throws, whatever half-typed text it is handed', () => {
    const junk = ['---\n---\n---\n', "---\nname: 'unclosed\n---\n", '---\nname:x:y\n---\n', '\u0000---\n', '---\n'.repeat(50)]
    for (const text of junk) expect(() => liveHeader(text)).not.toThrow()
  })
})
