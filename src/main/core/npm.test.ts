/**
 * Tests for the npm registry normalization (pure logic; the fetch is exercised
 * via the IPC layer at runtime, so here we feed canned raw payloads).
 */
import { describe, it, expect } from 'vitest'
import { normalizeSearchResults, type RawSearchPackage } from './npm.ts'

describe('normalizeSearchResults', () => {
  it('maps name/description/version and reads total', () => {
    const data = {
      total: 3,
      objects: [
        { package: { name: 'a', description: 'desc a', version: '1.0.0' } },
        { package: { name: 'b', description: 'desc b', version: '2.0.0' } },
      ],
    }
    const { hits, total } = normalizeSearchResults(data)
    expect(total).toBe(3)
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ name: 'a', description: 'desc a', version: '1.0.0' })
  })

  it('falls back to hits length when total is absent', () => {
    const { total } = normalizeSearchResults({ objects: [{ package: { name: 'a' } }] })
    expect(total).toBe(1)
  })

  it('maps author from a string and from an object', () => {
    const a = normalizeSearchResults({ objects: [{ package: { name: 'x', author: 'Ann' } }] })
    expect(a.hits[0].author).toBe('Ann')
    const b = normalizeSearchResults({ objects: [{ package: { name: 'x', author: { name: 'Bob' } } }] })
    expect(b.hits[0].author).toBe('Bob')
    const c = normalizeSearchResults({ objects: [{ package: { name: 'x' } }] })
    expect(c.hits[0].author).toBeUndefined()
  })

  it('carries date and keywords only when present', () => {
    const { hits } = normalizeSearchResults({
      objects: [{
        package: {
          name: 'y', date: '2026-01-02T00:00:00.000Z', keywords: ['dsh', 'plugin'],
        } as RawSearchPackage,
      }],
    })
    expect(hits[0].date).toBe('2026-01-02T00:00:00.000Z')
    expect(hits[0].keywords).toEqual(['dsh', 'plugin'])
    expect(hits[0].author).toBeUndefined()
  })

  it('drops entries without a name', () => {
    const { hits } = normalizeSearchResults({ objects: [{ package: {} }, { package: { name: 'z' } }] })
    expect(hits).toHaveLength(1)
    expect(hits[0].name).toBe('z')
  })
})