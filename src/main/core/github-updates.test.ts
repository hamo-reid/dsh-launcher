/**
 * GitHub-release normalisation + version picking for the launcher's own update
 * check. Pure logic only (no network): exactly the two functions that would need
 * a live API otherwise, keeping `checkAppUpdate`'s decision rule covered.
 */
import { describe, expect, it } from 'vitest'
import { normalizeRelease, pickLatestRelease, type RawGitHubRelease } from './github-updates.ts'

describe('normalizeRelease', () => {
  it('strips a leading v and maps the fields', () => {
    expect(normalizeRelease({ tag_name: 'v0.2.0-beta2', html_url: 'https://x/r/releases/2', published_at: '2026-01-01', prerelease: true }))
      .toEqual({ tag: '0.2.0-beta2', version: '0.2.0-beta2', url: 'https://x/r/releases/2', publishedAt: '2026-01-01' })
  })

  it('keeps a tag without a v prefix', () => {
    expect(normalizeRelease({ tag_name: '0.1.0' })).toMatchObject({ tag: '0.1.0' })
  })

  it('returns null when the tag is missing', () => {
    expect(normalizeRelease({})).toBeNull()
    expect(normalizeRelease({ tag_name: '  ' })).toBeNull()
  })
})

describe('pickLatestRelease', () => {
  const rel = (tag: string, url = `https://x/r/releases/${tag}`) => ({ tag, version: tag, url })

  it('picks the semantically-highest tag across an unordered list', () => {
    const list = [rel('0.3.0'), rel('0.2.0-beta2'), rel('0.9.5'), rel('0.10.0')]
    expect(pickLatestRelease(list)?.tag).toBe('0.10.0')
  })

  it('ranks prereleases above their lower ranges and below the final release', () => {
    expect(pickLatestRelease([rel('1.0.0'), rel('1.0.0-beta.2')])?.tag).toBe('1.0.0')
    expect(pickLatestRelease([rel('1.0.0-beta.2'), rel('0.9.9')])?.tag).toBe('1.0.0-beta.2')
  })

  it('returns null for an empty list', () => {
    expect(pickLatestRelease([])).toBeNull()
  })
})