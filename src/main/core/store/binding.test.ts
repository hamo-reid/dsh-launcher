/**
 * Binding derivation: which identity a profile's dependency points at.
 *
 * The cases pinned here are the ones that make the difference visible — a dev
 * link that is NOT a registered dev plugin, a version spec that pnpm resolved
 * from the store, and profiles that disagree with each other.
 */
import { describe, expect, it } from 'vitest'
import { aggregateBinding, bindingOf, devDirKey, specTarget } from './binding.ts'

const DEV = 'C:\\dev\\hamo-app'
const devDirs = new Set([devDirKey(DEV)])

describe('specTarget', () => {
  it('reads the directory out of link: and file:, and nothing out of a version', () => {
    expect(specTarget('link:C:/dev/x')).toBe('C:/dev/x')
    expect(specTarget('file:C:/store/archive/x/1.0.0')).toBe('C:/store/archive/x/1.0.0')
    expect(specTarget('^1.0.0')).toBeUndefined()
    expect(specTarget(undefined)).toBeUndefined()
  })
})

describe('bindingOf', () => {
  it('calls a link to a registered dev plugin a dev binding', () => {
    expect(bindingOf(`link:${DEV}`, devDirs)).toBe('dev')
  })

  it('ignores the spelling of the path, not just its text', () => {
    // The same directory written with another case or a trailing separator is
    // still the same directory; treating them as different would report `store`
    // for a profile that is plainly running the working copy.
    expect(bindingOf(`link:${DEV}\\`, devDirs)).toBe('dev')
    expect(bindingOf(`link:${DEV.toLowerCase()}`, devDirs)).toBe('dev')
  })

  it('treats a link that is not a registered dev plugin as external, not dev', () => {
    // A hand-made link to a build output is a real situation. Calling it a dev
    // plugin would make the UI claim management the launcher does not have.
    expect(bindingOf('link:C:/somewhere/else', devDirs)).toBe('external')
  })

  it('treats an archive path and a version range as store bindings', () => {
    expect(bindingOf('file:C:/store/archive/@me/x/1.0.0', devDirs)).toBe('store')
    expect(bindingOf('^1.0.0', devDirs)).toBe('store')
    expect(bindingOf('1.0.0', devDirs)).toBe('store')
  })

  it('answers missing when the profile does not depend on the package', () => {
    expect(bindingOf(undefined, devDirs)).toBe('missing')
    expect(bindingOf('', devDirs)).toBe('missing')
    expect(bindingOf('   ', devDirs)).toBe('missing')
  })
})

describe('aggregateBinding', () => {
  it('reports the one binding when every profile agrees', () => {
    expect(aggregateBinding(['dev', 'dev'])).toBe('dev')
    expect(aggregateBinding(['store'])).toBe('store')
  })

  it('reports mixed when profiles disagree, instead of picking a side', () => {
    // "p1 runs my working copy, p2 runs the published build" is exactly the state
    // a person needs to see; collapsing it would hide it.
    expect(aggregateBinding(['dev', 'store'])).toBe('mixed')
    expect(aggregateBinding(['dev', 'external'])).toBe('mixed')
  })

  it('ignores profiles that do not depend on the package', () => {
    expect(aggregateBinding(['dev', 'missing'])).toBe('dev')
    expect(aggregateBinding(['missing', 'missing'])).toBe('missing')
    expect(aggregateBinding([])).toBe('missing')
  })
})
