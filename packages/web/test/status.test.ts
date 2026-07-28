import { describe, it, expect } from 'vitest'
import { statusColor, actorColor, STATUS_LABEL } from '../src/status'
import type { TaskStatus } from '../src/types'

describe('statusColor', () => {
  it('maps a status to its --status-* token', () => {
    expect(statusColor('executing')).toBe('var(--status-executing)')
    expect(statusColor('done')).toBe('var(--status-done)')
  })
  it('has a label for every TaskStatus (no missing pill)', () => {
    const all: TaskStatus[] = [
      'backlog',
      'clarify',
      'planning',
      'executing',
      'validating',
      'blocked',
      'review',
      'done',
      'failed',
      'building',
    ]
    for (const s of all) {
      expect(STATUS_LABEL[s]).toBeTruthy()
      expect(statusColor(s)).toBe(`var(--status-${s})`)
    }
  })
})

describe('actorColor', () => {
  it('returns a dedicated token for a known actor', () => {
    expect(actorColor('main')).toBe('var(--actor-main)')
    expect(actorColor('code-reviewer')).toBe('var(--actor-code-reviewer)')
  })
  it('slugifies mixed-case / spaced actor names to the token form', () => {
    expect(actorColor('Frontend Specialist')).toBe('var(--actor-frontend-specialist)')
  })
  it('falls back to --actor-default for an unknown actor', () => {
    expect(actorColor('some-unknown-agent')).toBe('var(--actor-default)')
  })
})
