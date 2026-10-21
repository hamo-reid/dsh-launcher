/**
 * The main entry's console encoding shim and the launch banner it prints.
 *
 * Both exist because of one Windows-only bug: the banner reached the terminal as
 * `鈻堚枅…` although the source was already correct, because a terminal decodes
 * each console write as a whole with ONE code page and refuses the UTF-8 guess
 * for a short, colourless run of non-ASCII bytes. These tests pin the two halves
 * of the fix without a console: the BOM that settles the guess, and a banner
 * whose lines stay aligned so the logo cannot drift when edited.
 */
import { describe, expect, it } from 'vitest'
import { bannerLines, hookConsoleEncoding, LAUNCH_BANNER } from './console.ts'

/** A stand-in for a tty stream: records what reaches the stream underneath. */
function fakeTty(isTTY: boolean): { stream: NodeJS.WriteStream; seen: string[]; latin1: boolean } {
  const seen: string[] = []
  const state = { latin1: false }
  const stream = {
    isTTY,
    setDefaultEncoding(enc: string): void {
      state.latin1 = enc === 'latin1'
    },
    write(chunk: string | Uint8Array): boolean {
      seen.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    },
  } as unknown as NodeJS.WriteStream
  return {
    stream,
    seen,
    get latin1(): boolean {
      return state.latin1
    },
  }
}

describe('hookConsoleEncoding', () => {
  it('marks the start of every line of console output', () => {
    const tty = fakeTty(true)
    hookConsoleEncoding([tty.stream])
    tty.stream.write('first\nsecond\nthird')
    expect(tty.seen).toEqual(['\ufefffirst\n\ufeffsecond\n\ufeffthird'])
  })

  it('re-marks a continuation chunk that starts mid-line', () => {
    // One banner line can be split across writes; the second half still needs a
    // marker or it inherits the terminal's failed guess from the first half.
    const tty = fakeTty(true)
    hookConsoleEncoding([tty.stream])
    tty.stream.write('\ufefflo')
    tty.stream.write('go')
    expect(tty.seen[1]).toBe('\ufeffgo')
  })

  it('leaves a blank line unmarked', () => {
    const tty = fakeTty(true)
    hookConsoleEncoding([tty.stream])
    tty.stream.write('a\n\nb')
    expect(tty.seen[0]).toBe('\ufeffa\n\n\ufeffb')
  })

  it('writes raw bytes, so no encoding pass can translate newlines', () => {
    const tty = fakeTty(true)
    hookConsoleEncoding([tty.stream])
    expect(tty.latin1).toBe(true)
  })

  it('passes binary chunks through untouched', () => {
    const tty = fakeTty(true)
    hookConsoleEncoding([tty.stream])
    const bytes = Buffer.from([0x41, 0xff])
    tty.stream.write(bytes)
    expect(tty.seen[0]).toBe('A\uFFFD')
  })

  it('ignores a stream that is not a terminal and needs no marker', () => {
    // A piped/file sink is read back as UTF-8 by whoever consumes it; a BOM there
    // would land inside every line of a log file.
    const piped = fakeTty(false)
    hookConsoleEncoding([piped.stream])
    piped.stream.write('plain')
    expect(piped.seen).toEqual(['plain'])
    expect(piped.latin1).toBe(false)
  })
})

describe('launch banner', () => {
  it('keeps every art line the same width, so the logo cannot drift', () => {
    const widths = new Set(LAUNCH_BANNER.map(line => line.length))
    expect(widths.size).toBe(1)
  })

  it('draws box characters, not their mojibake', () => {
    const art = LAUNCH_BANNER.join('')
    expect(art).toContain('█')
    // The double-decoded forms would look "fine" in a diff but print as garbage.
    expect(art).not.toMatch(/[鈻堚枅鈺鈥锛]/u)
  })

  it('puts the version wordmark under the art rather than beside it', () => {
    const lines = bannerLines('0.5.0-beta1')
    expect(lines.slice(0, -1)).toEqual([...LAUNCH_BANNER])
    // Real versions are longer than the 21-column logo, so the caption starts at
    // the logo's left edge instead of drifting left of it.
    expect(lines.at(-1)).toBe(' LAUNCHER · v0.5.0-beta1')
  })

  it('centres the wordmark once it is narrower than the logo', () => {
    // A short version is what makes centring visible at all.
    const label = bannerLines('1.0.0').at(-1)!
    expect(label).toBe('    LAUNCHER · v1.0.0')
    expect(label.length - label.trimStart().length).toBe(4)
  })

  it('never hangs the wordmark off the left edge', () => {
    for (const version of ['1.0.0', '0.5.0-beta1', '10.20.30-rc.1']) {
      const label = bannerLines(version).at(-1)!
      expect(label.length - label.trimStart().length).toBeGreaterThanOrEqual(1)
    }
  })
})
