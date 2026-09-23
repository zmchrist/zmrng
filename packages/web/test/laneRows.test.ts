import { describe, it, expect } from 'vitest'
import {
  formatElapsed,
  formatTokens,
  laneRows,
  repoLabel,
  taskRepoLabel,
} from '../src/laneRows'
import type { LaneSnapshot, RepoTarget, Task, TaskUsage } from '../src/types'

const USAGE: TaskUsage = { tokensIn: 1200, tokensOut: 340, tokensCache: 0, costUsd: 0.42, turns: 3 }

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Task One',
    body: '',
    status: 'executing',
    sessionId: null,
    branch: null,
    worktree: null,
    prUrl: null,
    blockedKind: null,
    planPath: null,
    model: null,
    effort: null,
    style: null,
    flow: 'plan',
    repoId: 'zmrng',
    usage: USAGE,
    queued: false,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    ...over,
  }
}

const REPOS: RepoTarget[] = [
  { id: 'zmrng', label: 'zmrng', path: '/repos/zmrng', defaultBranch: 'main' },
  { id: 'other', label: 'Other App', path: '/repos/other', defaultBranch: 'main' },
]

function makeSnapshot(over: Partial<LaneSnapshot> = {}): LaneSnapshot {
  return {
    at: '2026-09-23T12:00:00.000Z',
    execute: { cap: 4, holders: [], queued: [] },
    workers: [],
    chats: [],
    terminals: [],
    ...over,
  }
}

describe('laneRows — the snapshot ↔ task-list join', () => {
  it('picks up title/status/usage/repo from the matching task', () => {
    const snapshot = makeSnapshot({
      execute: { cap: 4, holders: ['t1'], queued: [] },
      workers: [
        {
          taskId: 't1',
          model: 'opus',
          effort: 'high',
          style: 'caveman-full',
          startedAt: '2026-09-23T11:59:00.000Z',
          holdsLane: true,
          subagents: [
            {
              id: 's1',
              type: 'zmrng-qa',
              status: 'running',
              description: 'run the suite',
              startedAt: '2026-09-23T11:59:30.000Z',
            },
          ],
        },
      ],
    })
    const rows = laneRows(snapshot, [makeTask({ id: 't1', title: 'Task One' })], REPOS)

    expect(rows.lanes).toHaveLength(1)
    const row = rows.lanes[0]
    expect(row.taskId).toBe('t1')
    expect(row.title).toBe('Task One')
    expect(row.status).toBe('executing')
    expect(row.statusLabel).toBe('Executing')
    // the RESOLVED values the child was actually spawned with, not the task's nulls
    expect(row.model).toBe('opus')
    expect(row.effort).toBe('high')
    expect(row.style).toBe('caveman-full')
    expect(row.repoLabel).toBe('zmrng')
    expect(row.usage).toEqual(USAGE)
    expect(row.subagents).toHaveLength(1)
    expect(row.subagents[0].type).toBe('zmrng-qa')
  })

  it('drops a worker whose task is missing from the task list', () => {
    const snapshot = makeSnapshot({
      execute: { cap: 4, holders: ['gone'], queued: [] },
      workers: [
        {
          taskId: 'gone',
          model: 'opus',
          effort: 'high',
          style: 'normal',
          startedAt: '2026-09-23T11:59:00.000Z',
          holdsLane: true,
          subagents: [],
        },
      ],
    })
    const rows = laneRows(snapshot, [makeTask({ id: 't1' })], REPOS)
    expect(rows.lanes).toEqual([])
    expect(rows.clarify).toEqual([])
  })

  it('reports used/cap and the queue in promotion order', () => {
    const snapshot = makeSnapshot({
      execute: { cap: 2, holders: ['t1', 't2'], queued: ['t3', 't4'] },
    })
    const tasks = [
      makeTask({ id: 't1', title: 'One' }),
      makeTask({ id: 't2', title: 'Two' }),
      makeTask({ id: 't3', title: 'Three', status: 'backlog' }),
      makeTask({ id: 't4', title: 'Four', status: 'backlog' }),
    ]
    const rows = laneRows(snapshot, tasks, REPOS)
    expect(rows.execute.used).toBe(2)
    expect(rows.execute.cap).toBe(2)
    expect(rows.execute.queued.map((q) => q.title)).toEqual(['Three', 'Four'])
    expect(rows.execute.queued[0].taskId).toBe('t3')
    expect(rows.execute.queued[0].repoLabel).toBe('zmrng')
  })

  it('drops a queued entry whose task is unknown, keeping the rest in order', () => {
    const snapshot = makeSnapshot({ execute: { cap: 1, holders: [], queued: ['gone', 't4'] } })
    const rows = laneRows(snapshot, [makeTask({ id: 't4', title: 'Four' })], REPOS)
    expect(rows.execute.queued.map((q) => q.taskId)).toEqual(['t4'])
  })

  it('groups lane holders and unlaned clarify workers separately', () => {
    const snapshot = makeSnapshot({
      execute: { cap: 4, holders: ['t1'], queued: [] },
      workers: [
        {
          taskId: 't1',
          model: 'opus',
          effort: 'high',
          style: 'normal',
          startedAt: '2026-09-23T11:00:00.000Z',
          holdsLane: true,
          subagents: [],
        },
        {
          taskId: 't2',
          model: 'sonnet',
          effort: 'medium',
          style: 'normal',
          startedAt: '2026-09-23T11:30:00.000Z',
          holdsLane: false,
          subagents: [],
        },
      ],
    })
    const tasks = [
      makeTask({ id: 't1', title: 'One' }),
      makeTask({ id: 't2', title: 'Two', status: 'clarify' }),
    ]
    const rows = laneRows(snapshot, tasks, REPOS)
    expect(rows.lanes.map((r) => r.taskId)).toEqual(['t1'])
    expect(rows.clarify.map((r) => r.taskId)).toEqual(['t2'])
    expect(rows.clarify[0].holdsLane).toBe(false)
    expect(rows.clarify[0].model).toBe('sonnet')
  })

  it('resolves a chat row repo label, falling back to the Projects root', () => {
    const snapshot = makeSnapshot({
      chats: [
        {
          id: 'c1',
          model: 'opus',
          effort: 'high',
          style: 'normal',
          repoId: 'other',
          voice: false,
          startedAt: '2026-09-23T11:55:00.000Z',
          usage: USAGE,
        },
        {
          id: 'c2',
          model: 'sonnet',
          effort: 'low',
          style: 'normal',
          repoId: null,
          voice: true,
          startedAt: '2026-09-23T11:56:00.000Z',
          usage: USAGE,
        },
        {
          id: 'c3',
          model: 'sonnet',
          effort: 'low',
          style: 'normal',
          repoId: 'retired-repo',
          voice: false,
          startedAt: '2026-09-23T11:57:00.000Z',
          usage: USAGE,
        },
      ],
    })
    const rows = laneRows(snapshot, [], REPOS)
    expect(rows.chats.map((c) => c.repoLabel)).toEqual(['Other App', 'Projects root', 'Projects root'])
    expect(rows.chats[1].voice).toBe(true)
    expect(rows.chats[0].usage).toEqual(USAGE)
  })

  it('passes terminal rows through untouched', () => {
    const snapshot = makeSnapshot({
      terminals: [
        {
          id: 'term-1',
          shell: '/bin/bash',
          cwd: '/home/zc/dev',
          startedAt: '2026-09-23T11:50:00.000Z',
          attached: false,
        },
      ],
    })
    const rows = laneRows(snapshot, [], REPOS)
    expect(rows.terminals).toEqual([
      {
        id: 'term-1',
        shell: '/bin/bash',
        cwd: '/home/zc/dev',
        startedAt: '2026-09-23T11:50:00.000Z',
        attached: false,
      },
    ])
  })

  it('yields empty groups and a zero cap for a null snapshot', () => {
    const rows = laneRows(null, [makeTask()], REPOS)
    expect(rows).toEqual({
      execute: { used: 0, cap: 0, queued: [] },
      lanes: [],
      clarify: [],
      chats: [],
      terminals: [],
    })
  })
})

describe('formatElapsed', () => {
  const start = '2026-09-23T12:00:00.000Z'
  const at = (secs: number) => new Date(Date.parse(start) + secs * 1000).getTime()

  it('counts seconds below a minute', () => {
    expect(formatElapsed(start, at(0))).toBe('0s')
    expect(formatElapsed(start, at(45))).toBe('45s')
    expect(formatElapsed(start, at(59))).toBe('59s')
  })

  it('switches to minutes at the minute boundary', () => {
    expect(formatElapsed(start, at(60))).toBe('1m 00s')
    expect(formatElapsed(start, at(125))).toBe('2m 05s')
    expect(formatElapsed(start, at(3599))).toBe('59m 59s')
  })

  it('switches to hours at the hour boundary', () => {
    expect(formatElapsed(start, at(3600))).toBe('1h 00m')
    expect(formatElapsed(start, at(7_380))).toBe('2h 03m')
  })

  it('never renders a negative elapsed time (clock skew)', () => {
    expect(formatElapsed(start, at(-30))).toBe('0s')
  })

  it('renders an unparseable timestamp as a dash', () => {
    expect(formatElapsed('not-a-date', at(10))).toBe('—')
  })
})

describe('formatTokens', () => {
  it('groups thousands the same way the task list does', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(1200)).toBe('1,200')
    expect(formatTokens(1234567)).toBe('1,234,567')
    expect(formatTokens(1200.6)).toBe('1,201')
  })
})

describe('repoLabel', () => {
  it('resolves a registered repo, else the Projects root', () => {
    expect(repoLabel('other', REPOS)).toBe('Other App')
    expect(repoLabel(null, REPOS)).toBe('Projects root')
    expect(repoLabel('nope', REPOS)).toBe('Projects root')
  })
})

describe('taskRepoLabel', () => {
  it('resolves a registered repo, else the raw id (never the Projects root)', () => {
    // A task always targets a registered repo, so an id missing from the
    // registry is shown verbatim — the same fallback TaskList uses. Only a
    // CHAT can legitimately be rooted at the Projects dir.
    expect(taskRepoLabel('other', REPOS)).toBe('Other App')
    expect(taskRepoLabel('retired-repo', REPOS)).toBe('retired-repo')
  })
})
