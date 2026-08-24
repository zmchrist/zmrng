import { describe, it, expect } from 'vitest'
import type { Task, TaskStatus } from '../src/types'
import { concurrency, pipelineCounts, reviewQueue } from '../src/dashboardData'

/** Build a full Task with sensible defaults, overriding only what a test cares about. */
function mkTask(over: Partial<Task> & { id: string }): Task {
  return {
    id: over.id,
    title: over.title ?? `task ${over.id}`,
    body: '',
    status: 'backlog',
    sessionId: null,
    branch: null,
    worktree: null,
    prUrl: null,
    planPath: null,
    model: null,
    effort: null,
    style: null,
    flow: 'direct',
    repoId: 'zmrng',
    usage: { tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0, turns: 0 },
    queued: false,
    blockedKind: null,
    blockedReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function taskAt(id: string, status: TaskStatus, extra: Partial<Task> = {}): Task {
  return mkTask({ id, status, ...extra })
}

describe('pipelineCounts', () => {
  it('counts tasks per status in the fixed display order, with the correct total', () => {
    const tasks = [
      taskAt('1', 'backlog'),
      taskAt('2', 'backlog'),
      taskAt('3', 'clarify'),
      taskAt('4', 'executing'),
      taskAt('5', 'executing'),
      taskAt('6', 'review'),
      taskAt('7', 'done'),
    ]
    const { steps, total } = pipelineCounts(tasks)
    const order = steps.map((s) => s.status)
    expect(order).toEqual([
      'backlog',
      'clarify',
      'planning',
      'executing',
      'validating',
      'review',
      'done',
    ])
    const byStatus = Object.fromEntries(steps.map((s) => [s.status, s.count]))
    expect(byStatus.backlog).toBe(2)
    expect(byStatus.clarify).toBe(1)
    expect(byStatus.planning).toBe(0) // zero-count status still present
    expect(byStatus.executing).toBe(2)
    expect(byStatus.review).toBe(1)
    expect(byStatus.done).toBe(1)
    // total is the sum of the displayed steps
    expect(total).toBe(7)
  })

  it('carries a label and a token color per step', () => {
    const { steps } = pipelineCounts([])
    const exec = steps.find((s) => s.status === 'executing')!
    expect(exec.label).toBe('Executing')
    expect(exec.color).toBe('var(--status-executing)')
  })

  it('ignores statuses outside the pipeline (e.g. failed / archived) in the total', () => {
    const { total } = pipelineCounts([taskAt('1', 'failed'), taskAt('2', 'archived'), taskAt('3', 'done')])
    expect(total).toBe(1)
  })
})

describe('concurrency', () => {
  it('counts only executing tasks as active and echoes maxLanes', () => {
    const tasks = [
      taskAt('1', 'executing', { title: 'A' }),
      taskAt('2', 'executing', { title: 'B' }),
      taskAt('3', 'planning'),
      taskAt('4', 'review'),
    ]
    const c = concurrency(tasks, 2)
    expect(c.active).toBe(2)
    expect(c.max).toBe(2)
    expect(c.lanes.map((l) => l.title)).toEqual(['A', 'B'])
    expect(c.lanes.map((l) => l.id)).toEqual(['1', '2'])
  })

  it('counts queued===true tasks as queued', () => {
    const tasks = [
      taskAt('1', 'planning', { queued: true }),
      taskAt('2', 'planning', { queued: true }),
      taskAt('3', 'planning', { queued: false }),
      taskAt('4', 'executing'),
    ]
    const c = concurrency(tasks, 3)
    expect(c.queued).toBe(2)
    expect(c.active).toBe(1)
    expect(c.max).toBe(3)
  })
})

describe('reviewQueue', () => {
  it('includes only review/done tasks and surfaces their prUrl', () => {
    const tasks = [
      taskAt('1', 'review', { prUrl: 'https://github.com/o/r/pull/1' }),
      taskAt('2', 'done', { prUrl: 'https://github.com/o/r/pull/2' }),
      taskAt('3', 'executing'),
      taskAt('4', 'backlog'),
    ]
    const rows = reviewQueue(tasks)
    expect(rows.map((r) => r.id)).toEqual(['1', '2'])
    expect(rows[0]).toMatchObject({
      id: '1',
      status: 'review',
      prUrl: 'https://github.com/o/r/pull/1',
      repoId: 'zmrng',
    })
    expect(rows[1].status).toBe('done')
  })

  it('excludes non-review/done statuses entirely', () => {
    const rows = reviewQueue([taskAt('1', 'failed'), taskAt('2', 'clarify')])
    expect(rows).toHaveLength(0)
  })
})
