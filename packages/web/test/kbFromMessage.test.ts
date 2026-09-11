import { describe, it, expect } from 'vitest'
import { deriveKbTitle, resolveDefaultSpace } from '../src/kbFromMessage'
import type { Space } from '../src/types'

function space(id: number, name: string): Space {
  return {
    id,
    name,
    repoUrl: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  }
}

describe('deriveKbTitle', () => {
  it('reuses handoffTitle — first non-empty line, whitespace-collapsed', () => {
    expect(deriveKbTitle('\n  Promote   this  \nrest')).toBe('Promote this')
  })

  it('returns an empty string for an all-blank body (server falls back)', () => {
    expect(deriveKbTitle('   \n ')).toBe('')
  })
})

describe('resolveDefaultSpace', () => {
  const spaces = [space(1, 'general'), space(2, 'zmrng'), space(3, 'pheme')]

  it('matches a space whose name equals the channel name (case-insensitive)', () => {
    expect(resolveDefaultSpace('ZMRNG', spaces)?.id).toBe(2)
    expect(resolveDefaultSpace('pheme', spaces)?.id).toBe(3)
  })

  it('falls back to the general space when no name matches', () => {
    expect(resolveDefaultSpace('random-channel', spaces)?.id).toBe(1)
  })

  it('falls back to the first space when there is no general space', () => {
    const noGeneral = [space(5, 'alpha'), space(6, 'beta')]
    expect(resolveDefaultSpace('unmatched', noGeneral)?.id).toBe(5)
  })

  it('returns undefined when there are no spaces', () => {
    expect(resolveDefaultSpace('anything', [])).toBeUndefined()
  })
})
