/**
 * Reading what an MCP server sends back: the two framings (one JSON-RPC frame per
 * line, and SSE `data:` payloads) and the judgement of whether a frame is the
 * response to OUR request.
 *
 * Pure, and deliberately lenient about noise — a server may emit keep-alives and
 * somebody else's notifications, and none of that is an error. The three small
 * text utilities below are here because the framing needs them too.
 */



// ── pure helpers ────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function tail(current: string, chunk: string, cap: number): string {
  const next = current + chunk
  return next.length > cap ? next.slice(next.length - cap) : next
}

/** One JSON-RPC frame per line — see the framing note in the module header. */
export function consumeLines(rest: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (rest + chunk).split('\n')
  const remainder = parts.pop() ?? ''
  return {
    lines: parts.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line)).filter(line => line !== ''),
    rest: remainder,
  }
}

/** Complete `data:` payloads out of an SSE chunk. Lenient by design: `event:`
 * / `id:` / `retry:` / comment lines are skipped, and a frame split across two
 * chunks stays in `rest` until its newline arrives. */
export function consumeSseData(rest: string, chunk: string): { payloads: string[]; rest: string } {
  const { lines, rest: remainder } = consumeLines(rest, chunk)
  const payloads: string[] = []
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    // SSE allows one optional space after the colon.
    const payload = line.slice('data:'.length).replace(/^ /, '')
    if (payload !== '') payloads.push(payload)
  }
  return { payloads, rest: remainder }
}

/** Every JSON frame in an SSE body. A payload that is not JSON (a keep-alive
 * comment, a server's own chatter) is dropped rather than failing the probe. */
export function parseSseFrames(text: string): unknown[] {
  const { payloads } = consumeSseData('', text.endsWith('\n') ? text : `${text}\n`)
  const frames: unknown[] = []
  for (const payload of payloads) {
    try {
      frames.push(JSON.parse(payload))
    } catch { /* not a JSON frame */ }
  }
  return frames
}

export type ResponseVerdict =
  | { kind: 'ok'; result: Record<string, unknown> }
  | { kind: 'error'; code?: number; message: string }

/** Judge one frame as our initialize response. `null` means "not ours" — a
 * different id, not an object, or neither `result` nor `error` — so the caller
 * keeps waiting (a server may emit notifications before it answers). */
export function judgeResponse(frame: unknown): ResponseVerdict | null {
  if (!isRecord(frame)) return null
  if (frame['id'] !== INIT_ID) return null
  if (isRecord(frame['result'])) return { kind: 'ok', result: frame['result'] }
  const error = frame['error']
  if (isRecord(error)) {
    const code = typeof error['code'] === 'number' ? error['code'] : undefined
    return {
      kind: 'error',
      ...(code !== undefined ? { code } : {}),
      message: typeof error['message'] === 'string' ? error['message'] : 'the server reported an error',
    }
  }
  return null
}


/** The id of our one request; every other frame is somebody else's business. */
export const INIT_ID = 1
