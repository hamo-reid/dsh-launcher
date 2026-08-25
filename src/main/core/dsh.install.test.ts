/**
 * Tests for the official-install pure helpers: spec/version resolution, the
 * name-conflict guard, installed-version read-back, and bin-candidate lookup.
 * Mirrors `npm.test.ts` — pure logic only, no real network or pnpm.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickBinCandidate, readInstalledVersion, resolveInstallSpec, versionExists } from './dsh.ts'

describe('resolveInstallSpec', () => {
  it('pins an explicitly given version', () => {
    expect(resolveInstallSpec('0.1.0-rc.7', '0.1.0-rc.9')).toEqual({
      spec: '@deepseek-ai/dsh@0.1.0-rc.7',
      resolvedVersion: '0.1.0-rc.7',
    })
  })

  it('trims whitespace around the version', () => {
    expect(resolveInstallSpec('  1.2.3  ', '9.9.9')?.spec).toBe('@deepseek-ai/dsh@1.2.3')
  })

  it('falls back to latest when the version is empty (the version-empty bug)', () => {
    expect(resolveInstallSpec('', '0.1.0-rc.9')).toEqual({
      spec: '@deepseek-ai/dsh@0.1.0-rc.9',
      resolvedVersion: '0.1.0-rc.9',
    })
    expect(resolveInstallSpec(undefined, '0.1.0-rc.9')?.resolvedVersion).toBe('0.1.0-rc.9')
    expect(resolveInstallSpec('   ', '0.1.0-rc.9')?.resolvedVersion).toBe('0.1.0-rc.9')
  })

  it('is undefined when both version and latest are blank (canonical spec unavailable)', () => {
    expect(resolveInstallSpec('', undefined)).toBeUndefined()
    expect(resolveInstallSpec(undefined, '')).toBeUndefined()
  })
})

describe('versionExists', () => {
  it('is false for a missing or empty target dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-vex-'))
    try {
      expect(versionExists(join(root, 'missing'))).toBe(false)
      const empty = join(root, 'empty')
      mkdirSync(empty, { recursive: true })
      expect(versionExists(empty)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('is true for a non-empty target dir (a leftover install)', () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-vex-'))
    try {
      const dir = join(root, 'official')
      mkdirSync(join(dir, 'node_modules'), { recursive: true })
      expect(versionExists(dir)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('readInstalledVersion', () => {
  it('reads a real version', () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-ver-'))
    try {
      const p = join(root, 'package.json')
      writeFileSync(p, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.7' }))
      expect(readInstalledVersion(p)).toBe('0.1.0-rc.7')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to unknown for missing / malformed manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-ver-'))
    try {
      expect(readInstalledVersion(join(root, 'nope', 'package.json'))).toBe('unknown')
      const bad = join(root, 'package.json')
      writeFileSync(bad, 'not json')
      expect(readInstalledVersion(bad)).toBe('unknown')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('pickBinCandidate', () => {
  it('prefers .bin/dsh.cmd on win-style installs', () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-bin-'))
    try {
      const bin = join(root, 'node_modules', '.bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'dsh'), '#!/usr/bin/env node')
      writeFileSync(join(bin, 'dsh.cmd'), '@echo off')
      expect(pickBinCandidate(root)).toBe(join(bin, 'dsh.cmd'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to the .bin shim path when none exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-bin-'))
    try {
      mkdirSync(join(root, 'node_modules'), { recursive: true })
      expect(pickBinCandidate(root)).toBe(join(root, 'node_modules', '.bin', 'dsh'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})