/**
 * The `dshId` narrowing every handler relies on.
 *
 * The id comes from the renderer, so the guard has to reject everything that is
 * not a registered dsh's id — and it has to do so without throwing, because the
 * caller's fallback is a `dsh.notFound` envelope rather than an error.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../core/settings.ts'
import { updateDshState } from '../core/appState.ts'
import { ctxOf } from './ctxOf.ts'

let root: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pm-ctxof-'))
  await openDatabase(join(root, 'app.sqlite'))
  updateDshState(() => [{
    id: 'a', name: 'dsh@a', execPath: '/fake/a', version: '1.2.3', home: join(root, 'home'),
  }])
}, 20000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('ctxOf', () => {
  it('projects a registered entry onto the fields core operations need', () => {
    expect(ctxOf('a')).toEqual({ execPath: '/fake/a', home: join(root, 'home'), version: '1.2.3' })
  })

  it('resolves an unregistered id to null', () => {
    expect(ctxOf('gone')).toBeNull()
  })

  it('resolves a blank id to null', () => {
    expect(ctxOf('')).toBeNull()
  })

  it('resolves a non-string payload to null instead of throwing', () => {
    for (const value of [undefined, null, 7, {}, ['a'], true]) {
      expect(ctxOf(value)).toBeNull()
    }
  })
})
