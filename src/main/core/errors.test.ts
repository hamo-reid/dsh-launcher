/** Tests for the uniform IPC error envelope: AppError, throwE, fail, failFromError. */
import { describe, it, expect } from 'vitest'
import { AppError, E, fail, failFromError, throwE } from './errors.ts'

describe('AppError / throwE', () => {
  it('defaults the message to the code when none is given', () => {
    const err = new AppError('profile.exists')
    expect(err.code).toBe('profile.exists')
    expect(err.message).toBe('profile.exists')
    expect(err.name).toBe('AppError')
    expect(err.params).toBeUndefined()
  })

  it('carries params and an explicit message', () => {
    const err = new AppError('dsh.notFound', { detail: 'missing' }, 'custom msg')
    expect(err.code).toBe('dsh.notFound')
    expect(err.params).toEqual({ detail: 'missing' })
    expect(err.message).toBe('custom msg')
  })

  it('throwE throws an AppError', () => {
    expect(() => throwE(E.storeNotDir, { path: '/x' })).toThrowError(AppError)
    try {
      throwE(E.nameInvalid)
    } catch (e) {
      expect((e as AppError).code).toBe(E.nameInvalid)
    }
  })
})

describe('fail', () => {
  it('returns the code as text when params is a string array', () => {
    const r = fail('bundle.notFound', ['a', 'b'])
    expect(r).toMatchObject({ ok: false, code: 'bundle.notFound' })
    expect(r).toHaveProperty('error', 'a、b')
  })

  it('uses the detail param as text', () => {
    const r = fail('internal', { detail: 'boom' })
    expect((r as { error: string }).error).toBe('boom')
  })

  it('falls back to the raw code when no params/ detail', () => {
    const r = fail('yaml.invalid')
    expect((r as { error: string }).error).toBe('yaml.invalid')
    expect(r).toHaveProperty('params', undefined)
  })

  it('lets an explicit message win', () => {
    const r = fail('internal', { detail: 'detail' }, 'message wins')
    expect((r as { error: string }).error).toBe('message wins')
  })
})

describe('failFromError', () => {
  it('keeps code + params for an AppError', () => {
    const r = failFromError(new AppError('trash.conflict', ['dup'], 'conflict'))
    expect(r).toMatchObject({ ok: false, code: 'trash.conflict', params: ['dup'], error: 'conflict' })
  })

  it('maps a plain Error to the generic internal code', () => {
    const r = failFromError(new Error('raw failure'))
    expect(r).toMatchObject({ ok: false, code: 'internal', error: 'raw failure' })
    expect(r.ok === false ? r.params : undefined).toEqual({ detail: 'raw failure' })
  })

  it('maps a non-Error throwable to its string form', () => {
    const r = failFromError('string throw')
    expect(r).toMatchObject({ ok: false, code: 'internal', error: 'string throw' })
    expect(r.ok === false ? r.params : undefined).toEqual({ detail: 'string throw' })
  })
})

it('E exposes the documented codes', () => {
  expect(E).toMatchObject({
    internal: 'internal',
    dshNotFound: 'dsh.notFound',
    nameInvalid: 'name.invalid',
    profileExists: 'profile.exists',
    storeNotDir: 'store.notDir',
    yamlInvalid: 'yaml.invalid',
  })
})