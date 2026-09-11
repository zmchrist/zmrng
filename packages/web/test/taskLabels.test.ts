import { describe, it, expect } from 'vitest'
import { modelEffortLabel } from '../src/taskLabels'
import type { Task } from '../src/types'

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'x',
    body: '',
    status: 'executing',
    model: 'opus',
    effort: 'high',
    ...over,
  } as unknown as Task
}

describe('modelEffortLabel', () => {
  it('returns "idle" when no task is selected', () => {
    expect(modelEffortLabel(undefined)).toBe('idle')
  })

  it('renders an explicit model/effort pick verbatim', () => {
    expect(modelEffortLabel(task({ model: 'opus', effort: 'high' }))).toBe('opus / high')
    expect(modelEffortLabel(task({ model: 'sonnet', effort: 'medium' }))).toBe('sonnet / medium')
  })

  it('renders "auto" (never the literal "null") for an unresolved model/effort', () => {
    // D2 persists NULL until a phase resolves its own default at spawn.
    expect(modelEffortLabel(task({ model: null, effort: null }))).toBe('auto / auto')
    expect(modelEffortLabel(task({ model: null, effort: null }))).not.toContain('null')
  })

  it('handles a half-resolved pair (one picked, one null)', () => {
    expect(modelEffortLabel(task({ model: 'sonnet', effort: null }))).toBe('sonnet / auto')
    expect(modelEffortLabel(task({ model: null, effort: 'high' }))).toBe('auto / high')
  })
})
