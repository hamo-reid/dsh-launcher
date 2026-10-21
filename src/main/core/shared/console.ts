/**
 * Console encoding for the launch output, kept out of the entry file so it can be
 * tested without booting Electron.
 *
 * The bug it exists for: the launch banner reached the terminal as `鈻堚枅…` while
 * the source was already correct (this repo really does hold `██████╗`, not its
 * double-decoded form). A Windows terminal decodes each console write as a whole
 * with ONE code page, and refuses the UTF-8 guess for a short, colourless run of
 * non-ASCII bytes — the banner is ~120 — then decodes that write plus everything
 * after it in the same chunk as CP437. Our log lines are longer and lose only
 * their alignment. The code page belongs to the attaching terminal, so
 * `chcp.com`, which only changes its own console, cannot repair it.
 */

import { setDefaultHighWaterMark } from 'node:stream'

/** The marker that settles the terminal's UTF-8-versus-OEM guess. No console can
 * read U+FEFF as text, so it is unambiguous: decoded correctly it is dropped,
 * and on a CP437 fallback it costs one stray glyph instead of mangling the line. */
const MARK = '\ufeff'

/** Prepend {@link MARK} to every line written to a console stream and stop the
 * stream from re-encoding our bytes.
 *
 * `streams` is a parameter only so a test can drive it without a real console;
 * the app passes process.stdout / process.stderr. A non-tty stream (a pipe, a log
 * file, a capturing parent) is left alone: whoever reads it decodes UTF-8 itself,
 * and a marker there would sit inside every line. */
export function hookConsoleEncoding(
  streams: readonly (NodeJS.WriteStream | NodeJS.ReadStream)[] = [process.stdout, process.stderr],
): void {
  // `writableHighWaterMark` is captured from the default when a stream is
  // constructed, and Electron builds stdio before this file runs.
  setDefaultHighWaterMark(false, 1)
  for (const stream of streams) {
    if (stream.isTTY !== true || !('write' in stream)) continue
    const out = stream as NodeJS.WriteStream
    // Raw bytes out: no encoding pass, no CP_ACP newline translation — and no
    // runtime cost, since a single-byte write skips the very console path. This is
    // the pattern Node's own docs prescribe for tty output, and dropping it once
    // re-broke this fix on Node 22.
    out.setDefaultEncoding('latin1')
    // eslint-disable-next-line @typescript-eslint/unbound-method -- false positive: the patched write callback checks `stream._writableState.objectMode`
    const write = out.write.bind(out) as (...args: unknown[]) => boolean
    out.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (typeof chunk !== 'string') return write(chunk, ...rest)
      // Every line, not just the first: a chunk can be split mid-line, and blank
      // lines need no marker.
      return write(chunk.replace(/^(?=[^\n])/gm, MARK), ...rest)
    }) as typeof out.write
  }
}

/** The launch banner art. Kept as data so its fixed-width layout can be
 * asserted — a stray character silently shifts the whole logo. */
export const LAUNCH_BANNER: readonly string[] = [
  ' ██████╗ ███████╗██╗  ██╗',
  ' ██╔══██╗██╔════╝██║  ██║',
  ' ██║  ██║███████╗███████║',
  ' ██║  ██║╚════██║██╔══██║',
  ' ██████╔╝███████║██║  ██║',
  ' ╚═════╝ ╚══════╝╚═╝  ╚═╝',
]

/** The banner as printed: the art plus the version wordmark, centred under it
 * rather than hung off the left edge where it reads as a stray line. */
export function bannerLines(version: string): string[] {
  const label = `LAUNCHER · v${version}`
  const pad = Math.max(1, Math.floor((LAUNCH_BANNER[0]!.length - label.length) / 2))
  return [...LAUNCH_BANNER, `${' '.repeat(pad)}${label}`]
}
