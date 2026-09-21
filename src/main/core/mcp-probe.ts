/**
 * MCP connectivity probe: really connect to one server and report the verdict.
 *
 * A single `initialize` handshake — no tools are ever called. stdio servers are
 * spawned and spoken to over newline-delimited JSON-RPC; streamable-http
 * servers get one POST. The result is a VALUE (`McpProbeResult`), never a
 * thrown error: "the server is down" is a successful probe with `ok:false`.
 *
 * Framing: MCP's stdio transport is NEWLINE-DELIMITED JSON — one message per
 * line, never containing a raw newline. It is NOT the `Content-Length` framing
 * LSP uses; the two are constantly confused, and using the LSP parser here
 * would hang forever.
 *
 * No evaluation, ever. `js`-mode env/header values are authored in a patch file
 * that a profile export or backup can carry, so running them in the main
 * process would turn the launcher into an arbitrary-code-execution surface.
 * `resolveJsExpr` only substitutes `process.env.<NAME>` and `${...}`
 * interpolations textually, and gives up (returning `null`) on anything else.
 *
 * Deliberately Electron-free and self-contained: the default deps are the real
 * implementations, so nothing here needs wiring in `main/index.ts` (unlike the
 * crypto/trash deps, which the main process must inject).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { mcpSecretsEnv } from './mcp-secrets.ts'
import { child } from './logger.ts'
import type { McpKV, McpProbeResult, McpProbeStage, McpServerInput } from '../../shared/types.ts'

const mlog = child('mcp')

/** The revision this probe asks for. The server may answer with any other
 * version it supports — the spec says it must reply with what it supports
 * rather than erroring — so a different value is reported, never rejected. */
const MCP_PROTOCOL_VERSION = '2025-06-18'

/** Ceiling for a stdio handshake. A cold `npx -y <pkg>` may have to download
 * the package first, which is the only legitimate long tail; a server that
 * exits, fails to spawn, or answers early returns immediately. */
const MCP_PROBE_TIMEOUT_MS = 30_000

/** HTTP probe ceiling, matching `github-auth`'s PROBE_TIMEOUT_MS. */
const MCP_PROBE_HTTP_TIMEOUT_MS = 10_000

/** How much stderr (or SSE/JSON noise) to keep for the diagnostic detail line. */
const STDERR_TAIL_CAP = 2048
const NOISE_TAIL_CAP = 512

/** The id of our one request; every other frame is somebody else's business. */
const INIT_ID = 1

// ── injected side effects (project convention: module-level, swappable) ──────

export interface McpProbeDeps {
  spawn: typeof spawn
  /** Stop the probe process AND its tree. */
  kill: (proc: ChildProcess) => void
  fetch: typeof fetch
}

/**
 * Kill a probe process tree. `/T` is not optional: under `shell: true` on
 * Windows the child is `cmd.exe` and the real server (`npx` → `node`) is its
 * grandchild, so killing only the child leaves an orphan holding the port.
 */
function killProbeTree(proc: ChildProcess): void {
  if (proc.pid === undefined) return
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']) } catch { /* already gone */ }
  } else {
    try { process.kill(proc.pid, 'SIGTERM') } catch { /* already gone */ }
  }
}

const realDeps: McpProbeDeps = {
  spawn,
  kill: killProbeTree,
  fetch: (input, init) => globalThis.fetch(input, init),
}

let deps: McpProbeDeps = { ...realDeps }

/** Swap in fakes for tests (see `setSkillTrash` / `setMcpSecretCipher`). */
export function setMcpProbeDeps(next: Partial<McpProbeDeps>): void {
  deps = { ...deps, ...next }
}

/** Restore the real implementations. */
export function resetMcpProbeDeps(): void {
  deps = { ...realDeps }
}

// ── pure helpers ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tail(current: string, chunk: string, cap: number): string {
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

// ── the stdio handshake ─────────────────────────────────────────────────────

/** The slice of a `ChildProcess` the handshake touches, loose enough that a
 * test can drive it with a bare EventEmitter pair (the `dsh.test.ts` shape). */
export interface McpProbeChild {
  stdin: { write(chunk: string): unknown; on(event: string, listener: (error: Error) => void): unknown } | null
  stdout: { on(event: string, listener: (chunk: unknown) => void): unknown } | null
  stderr: { on(event: string, listener: (chunk: unknown) => void): unknown } | null
  onClose(listener: (code: number | null) => void): void
  onError(listener: (error: Error) => void): void
}

export interface StdioHandshakeOpts {
  clientVersion: string
  timeoutMs: number
}

function initializeRequest(clientVersion: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: INIT_ID,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      // Claiming nothing keeps a server from sending roots/sampling requests
      // that this one-shot probe would never answer.
      capabilities: {},
      clientInfo: { name: 'profile-manager', version: clientVersion },
    },
  }
}

/**
 * Speak the initialize handshake over an already-spawned child. Does NOT kill
 * it — the caller owns the process (see `runStdioProbe`'s `finally`).
 */
export function runStdioHandshake(proc: McpProbeChild, opts: StdioHandshakeOpts): Promise<McpProbeResult> {
  return new Promise<McpProbeResult>((resolve) => {
    const startedAt = Date.now()
    let settled = false
    let stdoutRest = ''
    let stderrTail = ''
    let noiseTail = ''
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (result: Omit<McpProbeResult, 'elapsedMs'>): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({ ...result, elapsedMs: Date.now() - startedAt })
    }
    const fail = (stage: McpProbeStage, reason: string, detail?: string): void => {
      finish({ ok: false, stage, reason, ...(detail !== undefined && detail !== '' ? { detail } : {}) })
    }
    const evidence = (): string | undefined => {
      const text = stderrTail.trim() !== '' ? stderrTail : noiseTail
      return text.trim() === '' ? undefined : text.trim()
    }

    const write = (frame: unknown): void => {
      try {
        proc.stdin?.write(`${JSON.stringify(frame)}\n`)
      } catch {
        // The close/error path already reports the failure; a write to a dead
        // pipe must not become an unhandled throw.
      }
    }

    proc.stdout?.on('data', (chunk: unknown) => {
      const { lines, rest } = consumeLines(stdoutRest, String(chunk))
      stdoutRest = rest
      for (const line of lines) {
        let frame: unknown
        try {
          frame = JSON.parse(line)
        } catch {
          // Servers print banners and npm chatter on stdout; that is noise, not
          // a protocol error.
          noiseTail = tail(noiseTail, `${line}\n`, NOISE_TAIL_CAP)
          continue
        }
        const verdict = judgeResponse(frame)
        if (verdict === null) continue
        if (verdict.kind === 'error') {
          fail('protocol', verdict.message, verdict.code !== undefined ? `code ${verdict.code}` : evidence())
          return
        }
        const serverInfo = isRecord(verdict.result['serverInfo']) ? verdict.result['serverInfo'] : undefined
        const negotiated = typeof verdict.result['protocolVersion'] === 'string'
          ? verdict.result['protocolVersion']
          : undefined
        // A real client acknowledges the result before doing anything else.
        write({ jsonrpc: '2.0', method: 'notifications/initialized' })
        finish({
          ok: true,
          ...(typeof serverInfo?.['name'] === 'string' ? { serverName: serverInfo['name'] } : {}),
          ...(typeof serverInfo?.['version'] === 'string' ? { serverVersion: serverInfo['version'] } : {}),
          ...(negotiated !== undefined ? { protocolVersion: negotiated } : {}),
          ...(negotiated !== undefined && negotiated !== MCP_PROTOCOL_VERSION
            ? { requestedProtocolVersion: MCP_PROTOCOL_VERSION }
            : {}),
        })
        return
      }
    })
    proc.stderr?.on('data', (chunk: unknown) => {
      stderrTail = tail(stderrTail, String(chunk), STDERR_TAIL_CAP)
    })
    // A write to a stdin whose process already died emits 'error' asynchronously;
    // unhandled, that is an uncaughtException — i.e. a crashed main process.
    proc.stdin?.on('error', () => { /* reported through close/error above */ })
    proc.onError((error: Error) => {
      fail('spawn', messageOf(error))
    })
    proc.onClose((code: number | null) => {
      fail('handshake', code === null ? 'the server closed its streams' : `the server exited with code ${code}`, evidence())
    })

    timer = setTimeout(() => {
      fail('timeout', `no initialize response within ${Math.round(opts.timeoutMs / 1000)}s`, evidence())
    }, opts.timeoutMs)

    if (proc.stdin === null || proc.stdin === undefined) {
      fail('spawn', 'the server has no stdin pipe')
      return
    }
    write(initializeRequest(opts.clientVersion))
  })
}

// ── transports ──────────────────────────────────────────────────────────────

async function runStdioProbe(
  input: McpServerInput,
  command: string,
  env: Record<string, string>,
  clientVersion: string,
): Promise<McpProbeResult> {
  const args = input.args ?? []
  const cwd = (input.cwd ?? '').trim()
  let proc: ChildProcess
  try {
    proc = deps.spawn(command, process.platform === 'win32' ? args.map(quoteForShell) : args, {
      // Windows resolves `npx`/`bunx` to `.cmd` shims that Node refuses to
      // execute without a shell — and refuses to spawn directly at all since
      // the CVE-2024-27980 fix. `dsh.ts` spawns `dsh` the same way.
      shell: process.platform === 'win32',
      // stdin MUST stay a pipe: a server reading JSON-RPC from /dev/null sees
      // EOF and exits before the handshake (the same trap `run.ts` records).
      stdio: ['pipe', 'pipe', 'pipe'],
      // `process.env` is not optional — passing `env` replaces it wholesale, and
      // without PATH every command fails with a misleading ENOENT.
      env: { ...process.env, ...env },
      // Without an explicit cwd the child inherits the launcher's install dir,
      // which a server writing relative files would then pollute.
      cwd: cwd === '' ? homedir() : cwd,
      windowsHide: true,
    })
  } catch (error) {
    return { ok: false, stage: 'spawn', reason: messageOf(error), elapsedMs: 0 }
  }

  const handle: McpProbeChild = {
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    onClose: listener => { proc.on('close', code => listener(code)) },
    onError: listener => { proc.on('error', listener) },
  }
  try {
    return await runStdioHandshake(handle, { clientVersion, timeoutMs: MCP_PROBE_TIMEOUT_MS })
  } finally {
    // Every path — success included — must leave no server process behind.
    deps.kill(proc)
  }
}

async function runHttpProbe(
  url: string,
  headers: Record<string, string>,
  clientVersion: string,
): Promise<McpProbeResult> {
  const startedAt = Date.now()
  const elapsed = (): number => Date.now() - startedAt
  let response: Response
  try {
    response = await deps.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Both are required: a spec-compliant streamable-http server answers
        // 406 when the client only accepts application/json.
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(initializeRequest(clientVersion)),
      signal: AbortSignal.timeout(MCP_PROBE_HTTP_TIMEOUT_MS),
      // A session id comes back on the initialize response and would be needed
      // for any follow-up request; this probe sends exactly one, so there is
      // nothing to carry it on. (Add it if `tools/list` is ever wired in.)
    })
  } catch (error) {
    const name = isRecord(error) ? error['name'] : undefined
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    return {
      ok: false,
      stage: timedOut ? 'timeout' : 'handshake',
      reason: messageOf(error),
      elapsedMs: elapsed(),
    }
  }

  const status = `HTTP ${response.status}`
  const contentType = response.headers.get('content-type') ?? ''
  const verdict = contentType.includes('text/event-stream')
    ? await readSseVerdict(response)
    : await readJsonVerdict(response)

  if (verdict === undefined) {
    return {
      ok: false,
      stage: response.ok ? 'protocol' : 'http',
      reason: response.ok ? 'the response carried no initialize result' : status,
      detail: status,
      elapsedMs: elapsed(),
    }
  }
  if (verdict.kind === 'error') {
    return {
      ok: false,
      stage: 'protocol',
      reason: verdict.message,
      ...(verdict.code !== undefined ? { detail: `${status} · code ${verdict.code}` } : { detail: status }),
      elapsedMs: elapsed(),
    }
  }
  if (!response.ok) {
    return { ok: false, stage: 'http', reason: status, detail: status, elapsedMs: elapsed() }
  }

  const serverInfo = isRecord(verdict.result['serverInfo']) ? verdict.result['serverInfo'] : undefined
  const negotiated = typeof verdict.result['protocolVersion'] === 'string' ? verdict.result['protocolVersion'] : undefined
  return {
    ok: true,
    elapsedMs: elapsed(),
    ...(typeof serverInfo?.['name'] === 'string' ? { serverName: serverInfo['name'] } : {}),
    ...(typeof serverInfo?.['version'] === 'string' ? { serverVersion: serverInfo['version'] } : {}),
    ...(negotiated !== undefined ? { protocolVersion: negotiated } : {}),
    ...(negotiated !== undefined && negotiated !== MCP_PROTOCOL_VERSION
      ? { requestedProtocolVersion: MCP_PROTOCOL_VERSION }
      : {}),
  }
}

async function readJsonVerdict(response: Response): Promise<ResponseVerdict | undefined> {
  try {
    const body: unknown = await response.json()
    return judgeResponse(body) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Read an SSE body until the initialize response shows up, then stop.
 *
 * The stream is cancelled the moment we have the frame: the spec only says a
 * server SHOULD close it, so `await response.text()` can hang on a server that
 * keeps it open for push — and every probe would report a bogus timeout.
 */
async function readSseVerdict(response: Response): Promise<ResponseVerdict | undefined> {
  const body = response.body
  if (body === null) {
    for (const frame of parseSseFrames(await response.text())) {
      const verdict = judgeResponse(frame)
      if (verdict !== null) return verdict
    }
    return undefined
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let rest = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const { payloads, rest: remainder } = consumeSseData(rest, decoder.decode(value, { stream: true }))
      rest = remainder
      for (const payload of payloads) {
        let frame: unknown
        try {
          frame = JSON.parse(payload)
        } catch {
          continue
        }
        const verdict = judgeResponse(frame)
        if (verdict !== null) return verdict
      }
    }
  } catch {
    return undefined
  } finally {
    try { await reader.cancel() } catch { /* already closed */ }
  }
  return undefined
}

// ── entry point ─────────────────────────────────────────────────────────────

/** Really connect to one MCP server and report the verdict. Never throws for a
 * server-side problem — a dead server comes back as `ok:false` with a reason. */
export async function probeMcpServer(
  input: McpServerInput,
  opts?: { clientVersion?: string },
): Promise<McpProbeResult> {
  const clientVersion = opts?.clientVersion ?? '0.0.0'
  const secrets = mcpSecretsEnv()
  // stdio servers read credentials from the environment; http servers send them
  // as request headers. Only one of the two lists is meaningful per transport.
  const connection = resolveKv(input.transport === 'stdio' ? input.env : input.headers, secrets)
  const caveat = connection.missing.length > 0 ? { unevaluated: connection.missing } : {}

  try {
    if (input.transport === 'stdio') {
      const command = (input.command ?? '').trim()
      if (command === '') {
        return { ok: false, stage: 'config', reason: 'a stdio server needs a command', elapsedMs: 0, ...caveat }
      }
      const result = await runStdioProbe(input, command, connection.values, clientVersion)
      return { ...result, ...caveat }
    }
    const url = (input.url ?? '').trim()
    if (url === '') {
      return { ok: false, stage: 'config', reason: 'a streamable-http server needs a url', elapsedMs: 0, ...caveat }
    }
    const result = await runHttpProbe(url, connection.values, clientVersion)
    return { ...result, ...caveat }
  } catch (error) {
    // A probe must never surface as an IPC failure — the card reports verdicts.
    mlog.warn(`probe failed unexpectedly for ${input.serverName}`, error)
    return { ok: false, stage: 'handshake', reason: messageOf(error), elapsedMs: 0, ...caveat }
  }
}
