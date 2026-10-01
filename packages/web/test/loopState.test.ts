import { describe, it, expect, beforeEach } from 'vitest'
import {
  LOOP_OPEN_RUN_KEY,
  MAX_LOOP_EVENTS,
  MAX_LOOP_PARTIAL_CHARS,
  appendLoopEvent,
  appendLoopPartial,
  isOrchestratorReply,
  loadOpenRunId,
  loopThread,
  mergeLoopEvents,
  removeRun,
  saveOpenRunId,
  upsertRun,
} from '../src/loopState'
import { appendPartial } from '../src/chatThread'
import type { LoopEvent, LoopEventPayload, LoopRun } from '../src/types'

const ZERO = { tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0, turns: 0 }

function run(id: string, over: Partial<LoopRun> = {}): LoopRun {
  return {
    id,
    repoId: 'zmrng',
    epic: 1,
    title: `Run ${id}`,
    status: 'draft',
    prevStatus: null,
    lanes: 1,
    integBranch: `gauntlet/${id}/integ`,
    integWorktree: null,
    priority: [],
    prUrl: null,
    note: null,
    usage: ZERO,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

function ev(id: number, payload: LoopEventPayload, kind: LoopEvent['kind'] = 'chat'): LoopEvent {
  return { id, runId: 'r1', ticket: null, kind, payload, createdAt: '2026-10-01T00:00:00.000Z' }
}

describe('open-run persistence', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips the open run id under its own key', () => {
    expect(loadOpenRunId()).toBeNull()
    saveOpenRunId('run-7')
    expect(localStorage.getItem(LOOP_OPEN_RUN_KEY)).toBe('run-7')
    expect(LOOP_OPEN_RUN_KEY).toBe('zmrng-loop-open-run')
    expect(loadOpenRunId()).toBe('run-7')
  })

  it('clears the key when the run is closed', () => {
    saveOpenRunId('run-7')
    saveOpenRunId(null)
    expect(localStorage.getItem(LOOP_OPEN_RUN_KEY)).toBeNull()
    expect(loadOpenRunId()).toBeNull()
  })

  it('treats a blank stored value as no open run', () => {
    localStorage.setItem(LOOP_OPEN_RUN_KEY, '  ')
    expect(loadOpenRunId()).toBeNull()
  })
})

describe('runs list', () => {
  it('replaces a known run in place', () => {
    const runs = [run('a'), run('b')]
    const next = upsertRun(runs, run('b', { status: 'running' }))
    expect(next.map((r) => r.id)).toEqual(['a', 'b'])
    expect(next[1].status).toBe('running')
    expect(runs[1].status).toBe('draft')
  })

  it('prepends a new run', () => {
    expect(upsertRun([run('a')], run('z')).map((r) => r.id)).toEqual(['z', 'a'])
  })

  it('drops a run that arrives archived', () => {
    expect(upsertRun([run('a'), run('b')], run('a', { status: 'archived' })).map((r) => r.id)).toEqual([
      'b',
    ])
  })

  it('removes a run by id', () => {
    expect(removeRun([run('a'), run('b')], 'a').map((r) => r.id)).toEqual(['b'])
  })
})

describe('events', () => {
  it('appends a newer event', () => {
    const next = appendLoopEvent([ev(1, {})], ev(2, {}))
    expect(next.map((e) => e.id)).toEqual([1, 2])
  })

  it('ignores an event it already holds (fetch/WS overlap)', () => {
    const events = [ev(1, {}), ev(2, {})]
    expect(appendLoopEvent(events, ev(2, {}))).toBe(events)
  })

  it('slots an out-of-order event into id order', () => {
    expect(appendLoopEvent([ev(1, {}), ev(3, {})], ev(2, {})).map((e) => e.id)).toEqual([1, 2, 3])
  })

  it('caps the list, dropping the oldest', () => {
    const many = Array.from({ length: MAX_LOOP_EVENTS }, (_, i) => ev(i + 1, {}))
    const next = appendLoopEvent(many, ev(MAX_LOOP_EVENTS + 1, {}))
    expect(next).toHaveLength(MAX_LOOP_EVENTS)
    expect(next[0].id).toBe(2)
    expect(next.at(-1)?.id).toBe(MAX_LOOP_EVENTS + 1)
  })

  it('merges a fetched page with events that streamed in meanwhile', () => {
    const fetched = [ev(1, {}), ev(2, {}), ev(3, {})]
    const live = [ev(3, {}), ev(4, {})]
    expect(mergeLoopEvents(fetched, live).map((e) => e.id)).toEqual([1, 2, 3, 4])
  })

  it('recognises a finalized orchestrator reply (and nothing else)', () => {
    expect(isOrchestratorReply(ev(1, { role: 'orchestrator', text: 'hi' }))).toBe(true)
    expect(isOrchestratorReply(ev(1, { role: 'operator', text: 'hi' }))).toBe(false)
    expect(isOrchestratorReply(ev(1, { role: 'tool', tool: 'Bash' }))).toBe(false)
    expect(isOrchestratorReply(ev(1, { text: 'x' }, 'activity'))).toBe(false)
  })

  it('accumulates a partial stream under a cap', () => {
    expect(appendLoopPartial('ab', 'cd')).toBe('abcd')
    const big = appendLoopPartial('x'.repeat(MAX_LOOP_PARTIAL_CHARS), 'yz')
    expect(big).toHaveLength(MAX_LOOP_PARTIAL_CHARS)
    expect(big.endsWith('yz')).toBe(true)
  })
})

describe('loopThread', () => {
  it('turns the chat transcript into bubbles and compact notes', () => {
    const items = loopThread([
      ev(1, { role: 'operator', text: 'start with two lanes' }),
      ev(2, { role: 'tool', tool: 'Bash', summary: 'curl POST /lanes' }),
      ev(3, { role: 'orchestrator', text: 'two lanes set' }),
      ev(4, { role: 'loop', text: '#12 WIN' }),
      ev(5, { text: 'spawn failed' }, 'error'),
    ])
    expect(items).toEqual([
      { kind: 'user', text: 'start with two lanes' },
      { kind: 'tool', name: 'Bash', summary: 'curl POST /lanes', actor: 'main' },
      { kind: 'agent', text: 'two lanes set', streaming: false },
      { kind: 'tool', name: 'loop', summary: '#12 WIN', actor: 'loop' },
      { kind: 'tool', name: 'error', summary: 'spawn failed', actor: 'loop' },
    ])
  })

  it('keeps lane activity and status lines out of the chat', () => {
    expect(
      loopThread([
        ev(1, { summary: 'Edit src/a.ts', step: 'builder' }, 'activity'),
        ev(2, { from: 'todo', to: 'executing' }, 'status'),
      ]),
    ).toEqual([])
  })

  it('gives each orchestrator reply its own closed bubble', () => {
    const items = loopThread([
      ev(1, { role: 'orchestrator', text: 'one' }),
      ev(2, { role: 'orchestrator', text: 'two' }),
    ])
    expect(items).toEqual([
      { kind: 'agent', text: 'one', streaming: false },
      { kind: 'agent', text: 'two', streaming: false },
    ])
  })

  it('streams the live partial as an open bubble after the transcript', () => {
    const base = loopThread([ev(1, { role: 'operator', text: 'hi' })])
    const shown = appendPartial({ items: base, busy: true }, 'thinking about it').items
    expect(shown.at(-1)).toEqual({ kind: 'agent', text: 'thinking about it', streaming: true })
  })
})
