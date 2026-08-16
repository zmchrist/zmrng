import { describe, it, expect } from 'vitest'
import { runPreflight } from '../src/preflight.js'

describe('runPreflight', () => {
  it('returns distinct claude/gh signals and never throws', () => {
    expect(() => runPreflight()).not.toThrow()
    const result = runPreflight()
    expect(result).toHaveProperty('claude')
    expect(result).toHaveProperty('gh')
    expect(typeof result.claude.ok).toBe('boolean')
    expect(typeof result.claude.detail).toBe('string')
    expect(typeof result.gh.ok).toBe('boolean')
    expect(typeof result.gh.detail).toBe('string')
    expect(result).toHaveProperty('path')
    for (const bin of ['git', 'gh', 'claude'] as const) {
      expect(typeof result.path[bin].ok).toBe('boolean')
      expect(typeof result.path[bin].detail).toBe('string')
    }
  })

  it('reports claude ok when ANTHROPIC_API_KEY is set', () => {
    const prev = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    try {
      const result = runPreflight()
      expect(result.claude.ok).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prev
    }
  })
})
