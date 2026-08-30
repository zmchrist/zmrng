import { describe, it, expect } from 'vitest'
import { isAhead } from '../src/versionPoller'

describe('isAhead', () => {
  it('is false when the remote sha is empty (nothing known yet)', () => {
    expect(isAhead('deadbeef', '')).toBe(false)
  })

  it('is false when remote matches the running local sha', () => {
    expect(isAhead('deadbeef', 'deadbeef')).toBe(false)
  })

  it('is true when a non-empty remote sha differs from local', () => {
    expect(isAhead('deadbeef', 'cafef00d')).toBe(true)
  })

  it('is true even when local is empty but a remote sha is known', () => {
    // A boot that could not read its own HEAD still learns of a remote version.
    expect(isAhead('', 'cafef00d')).toBe(true)
  })
})
