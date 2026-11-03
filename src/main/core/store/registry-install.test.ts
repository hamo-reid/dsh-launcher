/**
 * The end-to-end bet: pnpm, a private registry, and a token that only exists in
 * the child's environment.
 *
 * The unit tests above pin what the generated file SAYS. This one proves that
 * saying it is enough, because two assumptions cannot be tested any other way:
 *
 * 1. **pnpm honours `NPM_CONFIG_USERCONFIG`.** If it does not, the generated
 *    `.npmrc` is inert and pnpm resolves from whatever the machine is
 *    configured for — a private package would simply be "not found".
 * 2. **pnpm expands `${VAR}` in `.npmrc`.** If it does not, the auth value it
 *    sends is the literal `${PM_REGISTRY_TOKEN}` and the registry answers 401.
 *
 * Both are proved by the same assertion: the registry below answers 200 only to
 * one exact `Bearer` header, and the install succeeds. It also fails on purpose
 * with a wrong token, so a server that answered everything would not pass.
 *
 * The header scheme is a finding, not a guess: `_authToken` reaches the wire as
 * `Bearer`, so the launcher's own lookups send `Bearer` too (`store/npm.ts`).
 *
 * Fully offline: the registry is an HTTP server on 127.0.0.1 serving a tarball
 * built by `pnpm pack`, so no test depends on npmjs being reachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { openDatabase, patchSettings } from '../settings/settings.ts'
import { configurePnpmRegistryEnv, configurePnpmStore, runPnpm } from '../dsh/pnpm.ts'
import { applyRegistryConfig } from './registry-config.ts'
import { REGISTRY_TOKEN_ENV, setRegistryToken, setRegistryTokenCipher } from './registry-auth.ts'

/** The only credential the probe registry accepts. `_authToken` reaches the wire
 * as a Bearer header — verified here rather than assumed: the first version of
 * this test expected `Basic` and got a 401 from its own server. */
const TOKEN = 'probe-token-value'
const PACKAGE = '@probe/thing'
const VERSION = '1.0.0'

let root: string
let server: Server
let base = ''
let tarball: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
let configDir = ''

/** What a correct, fully-expanded configuration sends. */
const expectedAuth = `Bearer ${TOKEN}`

const ssri = (bytes: Uint8Array<ArrayBufferLike>, algorithm: 'sha1' | 'sha512'): string =>
  createHash(algorithm).update(bytes).digest(algorithm === 'sha1' ? 'hex' : 'base64')

/** Build the probe package once and serve its tarball. */
async function buildTarball(dir: string): Promise<Uint8Array<ArrayBufferLike>> {
  const pkg = join(dir, 'pkg')
  const out = join(dir, 'out')
  mkdirSync(pkg, { recursive: true })
  mkdirSync(out, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: PACKAGE, version: VERSION, main: 'index.js' }), 'utf8')
  writeFileSync(join(pkg, 'index.js'), 'module.exports = "probe"\n', 'utf8')
  const packed = await runPnpm(pkg, ['pack', '--pack-destination', out])
  if (!packed.ok) throw new Error(`pnpm pack failed: ${packed.text}`)
  const file = readdirSync(out).find(name => name.endsWith('.tgz'))
  if (file === undefined) throw new Error('pnpm pack produced no tarball')
  return new Uint8Array(readFileSync(join(out, file)))
}

/** One request answered the way a private registry answers it. */
function respond(req: { url?: string; headers: Record<string, unknown> }, res: import('node:http').ServerResponse): void {
  if (req.headers.authorization !== expectedAuth) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="probe"', 'content-type': 'application/json' })
    res.end('{"error":"unauthorized"}')
    return
  }
  const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
  if (path === `/${PACKAGE}`) {
    const metadata = {
      name: PACKAGE,
      'dist-tags': { latest: VERSION },
      versions: {
        [VERSION]: {
          name: PACKAGE,
          version: VERSION,
          dist: {
            tarball: `${base}/${PACKAGE}/-/${PACKAGE.split('/')[1] ?? 'thing'}-${VERSION}.tgz`,
            shasum: ssri(tarball, 'sha1'),
            integrity: `sha512-${ssri(tarball, 'sha512')}`,
          },
        },
      },
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(metadata))
    return
  }
  if (path === `/${PACKAGE}/-/thing-${VERSION}.tgz`) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(tarball)
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"error":"not found"}')
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-registry-install-'))
  await openDatabase(join(root, 'app.sqlite'))
  setRegistryTokenCipher({
    available: () => true,
    encrypt: plain => `enc(${plain})`,
    decrypt: stored => stored.replace(/^enc\(/, '').replace(/\)$/, ''),
  })
  tarball = await buildTarball(root)
  server = createServer(respond)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  configDir = join(root, 'config')
  // Wired exactly as `main/index.ts` wires it: the test exercises the real
  // provider, not a hand-built environment.
  configurePnpmRegistryEnv(() => applyRegistryConfig(configDir))
}, 120000)

afterAll(async () => {
  configurePnpmRegistryEnv(() => ({}))
  configurePnpmStore(() => undefined)
  setRegistryTokenCipher(null)
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  patchSettings({ registryUrl: base, registryScope: '@probe', registryTokenEnc: undefined })
})

/** A fresh pnpm project (and store) so one test cannot read another's cache. */
function project(tag: string): string {
  const dir = join(root, `proj-${tag}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `probe-${tag}`, version: '1.0.0', private: true }), 'utf8')
  return dir
}

describe('installing from a private registry', () => {
  it('installs a scoped package with the token supplied only as environment', async () => {
    // Both assumptions fail here if they are wrong: an inert user config sends
    // the request to npmjs (404), and an unexpanded `${VAR}` sends the wrong
    // header (401). Either way the package never lands.
    setRegistryToken(TOKEN)
    const dir = project('ok')
    configurePnpmStore(() => join(root, 'store-ok'))
    const result = await runPnpm(dir, ['add', PACKAGE, '--fetch-retries=0'])
    expect(result.text).toContain('@probe/thing')
    expect(result.ok).toBe(true)
    expect(existsSync(join(dir, 'node_modules', '@probe', 'thing', 'package.json'))).toBe(true)
    // The file it read names the variable; the value arrived through the
    // environment. A file containing the token would be a copy of the credential.
    const generated = readFileSync(join(configDir, 'npmrc'), 'utf8')
    expect(generated).toContain(`\${${REGISTRY_TOKEN_ENV}}`)
    expect(generated).not.toContain(TOKEN)
  }, 120000)

  it('fails against the same registry with a wrong token', async () => {
    // The control for the test above: the server does not answer everything, so
    // "it installed" means the header was right rather than that auth was never
    // checked.
    setRegistryToken('not-the-right-token')
    const dir = project('denied')
    configurePnpmStore(() => join(root, 'store-denied'))
    const result = await runPnpm(dir, ['add', PACKAGE, '--fetch-retries=0'])
    expect(result.ok).toBe(false)
    expect(result.text).toMatch(/401|unauthori[sz]ed|ERR_PNPM/i)
    expect(existsSync(join(dir, 'node_modules', '@probe', 'thing'))).toBe(false)
  }, 120000)
})
