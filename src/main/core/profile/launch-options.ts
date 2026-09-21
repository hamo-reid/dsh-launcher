/**
 * Normalize and validate per-profile launch parameters at the IPC boundary.
 *
 * Everything here is pure except the `--patch` existence check (real FS, so a
 * bad path fails before spawn with a clear code instead of mid-boot). The
 * launcher owns `--profile`/`--patch`, so those flags are rejected inside the
 * pass-through args — a user cannot silently retarget the profile.
 */

import { existsSync, statSync } from 'node:fs'
import { AppError } from '../shared/errors.ts'
import type { LaunchOptions } from '../../../shared/types.ts'

/** Normalized, validated launch options ready to assemble a command. */
interface SanitizedLaunchOptions {
  args: string[]
  patches: string[]
  env: Record<string, string>
  port?: number
}

/** Environment keys the launcher owns and must never let a user override:
 * overriding the first two breaks the bundled-Electron-as-node shim; the rest
 * would hijack how Node resolves modules / the executable lookup. */
const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
  'ELECTRON_RUN_AS_NODE', 'DSH_HOME', 'NODE_OPTIONS', 'NODE_PATH', 'PATH',
])

/** Launcher flags a user must not smuggle through the pass-through args: they
 * would override the profile/patch selection the launcher owns. `--host`/
 * `--port`/`--no-open`/`--trusted-host` are app-level and allowed. */
const RESERVED_ARG_FLAGS: ReadonlySet<string> = new Set([
  '--profile', '--patch', '--from-default-profile', '--dump-config', '--dump-default-config',
  '-V', '--version', '-h', '--help',
])

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Reject NUL/newlines (which cannot ride an argv/env entry safely). */
function cleanValue(code: string, value: string, params: Record<string, string>): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new AppError(code, params, `disallowed control characters in ${JSON.stringify(value)}`)
  }
  return value
}

function asStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

/** Normalize + validate raw launch options (never trust the renderer). Throws a
 * coded {@link AppError} on any invalid entry. */
export function sanitizeLaunchOptions(raw: unknown): SanitizedLaunchOptions {
  const input = (raw ?? {}) as LaunchOptions

  const args: string[] = []
  for (const a of asStringArray(input.args)) {
    if (a === '') continue
    const token = cleanValue('run.badArg', a, { value: a })
    if (RESERVED_ARG_FLAGS.has(token)) {
      throw new AppError('run.badArg', { value: token }, `reserved launcher flag: ${token}`)
    }
    args.push(token)
  }

  const patches: string[] = []
  for (const p of asStringArray(input.patches)) {
    if (p.trim() === '') continue
    const file = cleanValue('run.badPatch', p, { value: p })
    if (!existsSync(file)) throw new AppError('run.badPatch', { value: file }, `patch file not found: ${file}`)
    if (statSync(file).isDirectory()) throw new AppError('run.badPatch', { value: file }, `patch path is a directory: ${file}`)
    patches.push(file)
  }

  const env: Record<string, string> = {}
  const envRaw = input.env !== null && typeof input.env === 'object' ? input.env : {}
  for (const [key, value] of Object.entries(envRaw)) {
    if (typeof value !== 'string') continue
    if (!ENV_KEY_RE.test(key)) throw new AppError('run.badEnv', { key }, `invalid env key: ${key}`)
    if (RESERVED_ENV_KEYS.has(key)) throw new AppError('run.reservedEnv', { key }, `reserved env key: ${key}`)
    env[key] = cleanValue('run.badEnv', value, { key })
  }

  let port: number | undefined
  if (input.port !== undefined && input.port !== null) {
    const n = typeof input.port === 'number' ? input.port : Number(input.port)
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      throw new AppError('run.badPort', { port: String(input.port) }, `invalid port: ${String(input.port)}`)
    }
    port = n
  }

  return { args, patches, env, ...(port !== undefined && { port }) }
}

/** Compile sanitized options into the final pass-through argv: the extra args,
 * with the convenience web port appended as `--port <n>` last (so it wins over
 * a hand-written `--port`). */
export function effectiveArgs(options: SanitizedLaunchOptions): string[] {
  return options.port === undefined ? [...options.args] : [...options.args, '--port', String(options.port)]
}
