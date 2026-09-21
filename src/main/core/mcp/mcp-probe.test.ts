/**
 * `mcp-probe` behavior: the JSON-RPC line framing, the best-effort `js` value
 * resolver, the handshake state machine driven by a fake child, and the HTTP
 * response consumption (including the SSE stream that never closes).
 *
 * The handshake is exercised through `runStdioHandshake` with a bare
 * EventEmitter pair — the `dsh.test.ts` shape — so the protocol logic is
 * covered without spawning anything.
 */
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  consumeLines, consumeSseData, judgeResponse, parseSseFrames, probeMcpServer, quoteForShell,
  resetMcpProbeDeps, resolveJsExpr, resolveKv, runStdioHandshake, setMcpProbeDeps, type McpProbeChild,
} from './probe.ts'
import type { McpServerInput } from '../../../shared/types.ts'

/** A child stand-in: real emitters for the three streams plus close/error. */
function fakeChild(): McpProbeChild & {
  stdin: EventEmitter & { chunks: string[]; write: (chunk: string) => boolean }
  stdout: EventEmitter
  stderr: EventEmitter
  close: (code: number | null) => void
  fail: (error: Error) => void
  wrote: () => unknown[]
} {
  const stdin = Object.assign(new EventEmitter(), {
    chunks: [] as string[],
    write(this: { chunks: string[] }, chunk: string): boolean {
      this.chunks.push(chunk)
      return true
    },
  })
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const lifecycle = new EventEmitter()
  return {
    stdin,
    stdout,
    stderr,
    onClose: listener => { lifecycle.on('close', listener) },
    onError: listener => { lifecycle.on('error', listener) },
    close: code => { lifecycle.emit('close', code) },
    fail: error => { lifecycle.emit('error', error) },
    wrote: () => stdin.chunks.map(chunk => JSON.parse(chunk)),
  }
}

/** Push one JSON-RPC frame the way a server would: one line, then a newline. */
function emit(stream: EventEmitter, frame: unknown): void {
  stream.emit('data', `${JSON.stringify(frame)}\n`)
}

const INIT_RESULT = JSON.stringify({
  jsonrpc: '2.0', id: 1,
  result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'demo', version: '1.2.3' } },
})

const HANDSHAKE = { clientVersion: '9.9.9', timeoutMs: 5_000 }

describe('resolveJsExpr', () => {
  const secrets = { T: 'abc', A: 'a', B: 'b' }

  it('substitutes a template-literal process.env reference (the documented shape)', () => {
    expect(resolveJsExpr('`Bearer ${process.env.T}`', secrets)).toBe('Bearer abc')
  })

  it('substitutes a bare reference and a bracket reference', () => {
    expect(resolveJsExpr('process.env.T', secrets)).toBe('abc')
    expect(resolveJsExpr("process.env['T']", secrets)).toBe('abc')
  })

  it('substitutes a bare interpolation shorthand', () => {
    expect(resolveJsExpr('`Bearer ${T}`', secrets)).toBe('Bearer abc')
  })

  it('unwraps a plain quoted literal', () => {
    expect(resolveJsExpr("'Bearer literal'", secrets)).toBe('Bearer literal')
  })

  it('substitutes both sides of a composite template', () => {
    expect(resolveJsExpr('${process.env.A}-${process.env.B}', secrets)).toBe('a-b')
  })

  it('returns null for a missing name rather than sending a half-substituted value', () => {
    expect(resolveJsExpr('process.env.MISSING', secrets)).toBeNull()
    expect(resolveJsExpr('${process.env.A}-${process.env.MISSING}', secrets)).toBeNull()
  })

  it('refuses anything that would need evaluation', () => {
    expect(resolveJsExpr("(() => 'x')()", secrets)).toBeNull()
    expect(resolveJsExpr('process.env.A.toUpperCase()', secrets)).toBeNull()
  })
})

describe('consumeLines', () => {
  it('yields every complete frame of one chunk', () => {
    expect(consumeLines('', 'a\nb\n')).toEqual({ lines: ['a', 'b'], rest: '' })
  })

  it('keeps a frame split across two chunks until its newline arrives', () => {
    const first = consumeLines('', '{"id":')
    expect(first).toEqual({ lines: [], rest: '{"id":' })
    expect(consumeLines(first.rest, '1}\n')).toEqual({ lines: ['{"id":1}'], rest: '' })
  })

  it('strips CRLF, drops blank lines, and keeps a trailing partial', () => {
    expect(consumeLines('', 'a\r\n\r\nb\npart')).toEqual({ lines: ['a', 'b'], rest: 'part' })
  })
})

describe('SSE parsing', () => {
  it('takes the data payload and ignores event/id/comment lines', () => {
    const frames = parseSseFrames('event: message\n: keep-alive\nid: 7\ndata: {"a":1}\n\n')
    expect(frames).toEqual([{ a: 1 }])
  })

  it('accepts data: with and without the optional space', () => {
    expect(parseSseFrames('data:{"a":1}\ndata: {"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('drops a non-JSON payload instead of throwing', () => {
    expect(parseSseFrames('data: not json\ndata: {"ok":true}\n')).toEqual([{ ok: true }])
  })

  it('keeps a data line split across two chunks until it completes', () => {
    const first = consumeSseData('', 'data: {"a"')
    expect(first.payloads).toEqual([])
    expect(consumeSseData(first.rest, ':1}\n').payloads).toEqual(['{"a":1}'])
  })
})

describe('judgeResponse', () => {
  it('accepts an id-matched result object', () => {
    expect(judgeResponse({ id: 1, result: { protocolVersion: 'x' } }))
      .toEqual({ kind: 'ok', result: { protocolVersion: 'x' } })
  })

  it('reports a JSON-RPC error with its code', () => {
    expect(judgeResponse({ id: 1, error: { code: -32602, message: 'Invalid params' } }))
      .toEqual({ kind: 'error', code: -32602, message: 'Invalid params' })
  })

  it('ignores anything that is not our response', () => {
    expect(judgeResponse({ id: 2, result: {} })).toBeNull()
    expect(judgeResponse([])).toBeNull()
    expect(judgeResponse(null)).toBeNull()
    expect(judgeResponse({ id: 1 })).toBeNull()
  })
})

describe('quoteForShell', () => {
  it('quotes only what a shell would split or mangle', () => {
    expect(quoteForShell('-y')).toBe('-y')
    expect(quoteForShell('--config=C:\\My Dir\\x.json')).toBe('"--config=C:\\My Dir\\x.json"')
    expect(quoteForShell('a&b')).toBe('"a&b"')
  })
})

describe('resolveKv', () => {
  it('reads plain literally, env from the secret store, and js best-effort', () => {
    const result = resolveKv([
      { name: 'PLAIN', mode: 'plain', value: 'literal' },
      { name: 'FROM_STORE', mode: 'env' },
      { name: 'TEMPLATED', mode: 'js', value: '`Bearer ${process.env.PLAIN}`' },
    ], { FROM_STORE: 'secret', PLAIN: 'literal' })
    expect(result.values).toEqual({ PLAIN: 'literal', FROM_STORE: 'secret', TEMPLATED: 'Bearer literal' })
    expect(result.missing).toEqual([])
  })

  it('omits an unresolvable name entirely rather than sending an empty string', () => {
    const result = resolveKv([{ name: 'ABSENT', mode: 'env' }], {})
    expect(Object.keys(result.values)).toEqual([])
    expect(result.missing).toEqual(['ABSENT'])
  })

  it('skips blank names', () => {
    expect(resolveKv([{ name: '  ', mode: 'plain', value: 'x' }], {}).values).toEqual({})
  })
})

describe('runStdioHandshake', () => {
  it('sends initialize then the initialized notification, and reads the server identity', async () => {
    const child = fakeChild()
    const pending = runStdioHandshake(child, HANDSHAKE)
    emit(child.stdout, JSON.parse(INIT_RESULT))

    const result = await pending
    expect(result.ok).toBe(true)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.serverName).toBe('demo')
    expect(result.serverVersion).toBe('1.2.3')
    expect(result.protocolVersion).toBe('2025-06-18')
    expect(result.requestedProtocolVersion).toBeUndefined()

    const frames = child.wrote() as Array<Record<string, unknown>>
    expect(frames).toHaveLength(2)
    const params = frames[0]?.['params'] as Record<string, unknown>
    expect(frames[0]?.['method']).toBe('initialize')
    expect(frames[0]?.['id']).toBe(1)
    expect(params['protocolVersion']).toBe('2025-06-18')
    expect(params['capabilities']).toEqual({})
    expect((params['clientInfo'] as Record<string, unknown>)['version']).toBe('9.9.9')
    expect(frames[1]?.['method']).toBe('notifications/initialized')
  })

  it('accepts a negotiated-down protocol version and reports both', async () => {
    const child = fakeChild()
    const pending = runStdioHandshake(child, HANDSHAKE)
    emit(child.stdout, { id: 1, result: { protocolVersion: '2024-11-05' } })
    const result = await pending
    expect(result.ok).toBe(true)
    expect(result.protocolVersion).toBe('2024-11-05')
    expect(result.requestedProtocolVersion).toBe('2025-06-18')
  })

  it('reports a spawn failure from the error event', async () => {
    const child = fakeChild()
    const pending = runStdioHandshake(child, HANDSHAKE)
    child.fail(new Error('spawn npx ENOENT'))
    const result = await pending
    expect(result).toMatchObject({ ok: false, stage: 'spawn', reason: 'spawn npx ENOENT' })
  })

  it('reports a non-zero exit with the stderr tail as evidence', async () => {
    const child = fakeChild()
    const pending = runStdioHandshake(child, HANDSHAKE)
    child.stderr.emit('data', 'Error: missing API key\n')
    child.close(1)
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('handshake')
    expect(result.reason).toBe('the server exited with code 1')
    expect(result.detail).toContain('missing API key')
  })

  it('surfaces a JSON-RPC error frame as a protocol failure', async () => {
    const child = fakeChild()
    const pending = runStdioHandshake(child, HANDSHAKE)
    emit(child.stdout, { id: 1, error: { code: -32602, message: 'Invalid params' } })
    const result = await pending
    expect(result).toMatchObject({ ok: false, stage: 'protocol', reason: 'Invalid params', detail: 'code -32602' })
  })

  it('times out when the server never answers', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      const pending = runStdioHandshake(child, { ...HANDSHAKE, timeoutMs: 50 })
      await vi.advanceTimersByTimeAsync(60)
      const result = await pending
      expect(result).toMatchObject({ ok: false, stage: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores stdout noise and frames addressed to someone else', async () => {
    const child = fakeChild()
    const pending = runStdioHandshake(child, HANDSHAKE)
    child.stdout.emit('data', 'npm notice fetching package\n')
    emit(child.stdout, { id: 99, result: { protocolVersion: 'x' } })
    child.stdout.emit('data', `${INIT_RESULT}\n`)
    expect((await pending).ok).toBe(true)
  })

  it('survives a stdin error after the write (a dead pipe must not throw)', async () => {
    const child = fakeChild()
    const pending = runStdioHandshake(child, HANDSHAKE)
    child.stdin.emit('error', new Error('EPIPE'))
    emit(child.stdout, JSON.parse(INIT_RESULT))
    expect((await pending).ok).toBe(true)
  })

  it('fails fast when the child has no stdin pipe', async () => {
    const child = fakeChild()
    const result = await runStdioHandshake({ ...child, stdin: null }, HANDSHAKE)
    expect(result).toMatchObject({ ok: false, stage: 'spawn' })
  })
})

// ── orchestration ───────────────────────────────────────────────────────────

const stdioInput = (over: Partial<McpServerInput> = {}): McpServerInput => ({
  id: '', serverName: 'demo', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: [], cwd: '', ...over,
})

/** A child that answers the handshake as soon as it is written to. */
function answeringChild(): McpProbeChild {
  return {
    stdin: {
      write: (chunk: string) => {
        if (chunk.includes('"initialize"')) {
          setImmediate(() => {
            // Emitted after the caller has attached its listeners.
          })
        }
        return true
      },
      on: () => undefined,
    },
    stdout: { on: () => undefined },
    stderr: { on: () => undefined },
    onClose: listener => { setImmediate(() => listener(null)) },
    onError: () => undefined,
  }
}

describe('probeMcpServer orchestration', () => {
  it('spawns a stdio server with a piped stdin, a PATH-bearing env, and the platform shell rule', async () => {
    const spawnSpy = vi.fn((_command: string, _args: string[], _options: Record<string, unknown>) => answeringChild())
    const kill = vi.fn()
    setMcpProbeDeps({ spawn: spawnSpy as unknown as typeof import('node:child_process').spawn, kill })
    try {
      await probeMcpServer(stdioInput({ env: [{ name: 'TOKEN', mode: 'plain', value: 't' }] }))
      const [command, args, options] = spawnSpy.mock.calls[0] as [string, string[], Record<string, unknown>]
      expect(command).toBe('npx')
      expect(args).toEqual(['-y', 'pkg'])
      expect(options['stdio']).toEqual(['pipe', 'pipe', 'pipe'])
      expect(options['shell']).toBe(process.platform === 'win32')
      expect((options['env'] as Record<string, string>)['PATH']).toBeDefined()
      expect((options['env'] as Record<string, string>)['TOKEN']).toBe('t')
      // The probe must leave no server process behind, on any path.
      expect(kill).toHaveBeenCalledTimes(1)
    } finally {
      resetMcpProbeDeps()
    }
  })

  it('reports an incomplete stdio config without spawning', async () => {
    const spawnSpy = vi.fn()
    setMcpProbeDeps({ spawn: spawnSpy as unknown as typeof import('node:child_process').spawn })
    try {
      const result = await probeMcpServer(stdioInput({ command: '  ' }))
      expect(result).toMatchObject({ ok: false, stage: 'config' })
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      resetMcpProbeDeps()
    }
  })

  it('reports an incomplete http config without fetching', async () => {
    const fetchSpy = vi.fn()
    setMcpProbeDeps({ fetch: fetchSpy as unknown as typeof fetch })
    try {
      const result = await probeMcpServer({ id: '', serverName: 'demo', transport: 'streamable-http', url: ' ' })
      expect(result).toMatchObject({ ok: false, stage: 'config' })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      resetMcpProbeDeps()
    }
  })

  it('posts to an http server accepting both JSON and SSE, and reads a JSON result', async () => {
    const fetchSpy = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(INIT_RESULT, { status: 200, headers: { 'content-type': 'application/json' } })))
    setMcpProbeDeps({ fetch: fetchSpy as unknown as typeof fetch })
    try {
      const result = await probeMcpServer({
        id: '', serverName: 'demo', transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp',
        headers: [{ name: 'Authorization', mode: 'plain', value: 'Bearer t' }],
      })
      expect(result).toMatchObject({ ok: true, serverName: 'demo' })
      const init = (fetchSpy.mock.calls[0] as [string, RequestInit])[1]
      const headers = init.headers as Record<string, string>
      expect(headers['accept']).toBe('application/json, text/event-stream')
      expect(headers['content-type']).toBe('application/json')
      expect(headers['Authorization']).toBe('Bearer t')
      expect(init.method).toBe('POST')
    } finally {
      resetMcpProbeDeps()
    }
  })

  it('reads an SSE response whose stream never closes, without waiting for it', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${INIT_RESULT}\n\n`))
        // Deliberately left open — a push-style server. `await res.text()`
        // would hang here until the abort fires.
      },
      cancel() { cancelled = true },
    })
    setMcpProbeDeps({
      fetch: (async () => new Response(body, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch,
    })
    try {
      const result = await probeMcpServer({ id: '', serverName: 'demo', transport: 'streamable-http', url: 'http://x/mcp' })
      expect(result.ok).toBe(true)
      expect(result.serverName).toBe('demo')
      expect(cancelled).toBe(true)
    } finally {
      resetMcpProbeDeps()
    }
  })

  it('prefers the server message when a non-2xx body carries a JSON-RPC error', async () => {
    setMcpProbeDeps({
      fetch: (async () => new Response(JSON.stringify({ id: 1, error: { code: -32000, message: 'Unauthorized' } }), {
        status: 401, headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    })
    try {
      const result = await probeMcpServer({ id: '', serverName: 'demo', transport: 'streamable-http', url: 'http://x/mcp' })
      expect(result).toMatchObject({ ok: false, stage: 'protocol', reason: 'Unauthorized', detail: 'HTTP 401 · code -32000' })
    } finally {
      resetMcpProbeDeps()
    }
  })

  it('reports a bare HTTP failure when the body says nothing', async () => {
    setMcpProbeDeps({
      fetch: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
    })
    try {
      const result = await probeMcpServer({ id: '', serverName: 'demo', transport: 'streamable-http', url: 'http://x/mcp' })
      expect(result).toMatchObject({ ok: false, stage: 'http', detail: 'HTTP 500' })
    } finally {
      resetMcpProbeDeps()
    }
  })

  it('classifies a refused connection as a handshake failure and an abort as a timeout', async () => {
    setMcpProbeDeps({
      fetch: (async () => { throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }) }) as unknown as typeof fetch,
    })
    try {
      expect(await probeMcpServer({ id: '', serverName: 'd', transport: 'streamable-http', url: 'http://x/mcp' }))
        .toMatchObject({ ok: false, stage: 'handshake' })
    } finally {
      resetMcpProbeDeps()
    }

    setMcpProbeDeps({
      fetch: (async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }) as unknown as typeof fetch,
    })
    try {
      expect(await probeMcpServer({ id: '', serverName: 'd', transport: 'streamable-http', url: 'http://x/mcp' }))
        .toMatchObject({ ok: false, stage: 'timeout' })
    } finally {
      resetMcpProbeDeps()
    }
  })

  it('carries unevaluated js entries as a caveat, not a failure', async () => {
    setMcpProbeDeps({
      fetch: (async () => new Response(INIT_RESULT, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    })
    try {
      const result = await probeMcpServer({
        id: '', serverName: 'demo', transport: 'streamable-http', url: 'http://x/mcp',
        headers: [{ name: 'X', mode: 'js', value: 'someFn()' }],
      })
      expect(result.ok).toBe(true)
      expect(result.unevaluated).toEqual(['X'])
    } finally {
      resetMcpProbeDeps()
    }
  })
})
