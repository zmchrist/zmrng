import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { LanesPanel } from '../src/components/LanesPanel'
import type { LaneSnapshot, RepoTarget, Task, TaskUsage } from '../src/types'

const USAGE: TaskUsage = { tokensIn: 1200, tokensOut: 340, tokensCache: 0, costUsd: 0.42, turns: 3 }

const REPOS: RepoTarget[] = [
  { id: 'zmrng', label: 'zmrng', path: '/repos/zmrng', defaultBranch: 'main' },
]

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

const WORKER_SNAPSHOT = makeSnapshot({
  execute: { cap: 4, holders: ['t1'], queued: ['t2'] },
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
        {
          id: 's2',
          type: 'code-reviewer',
          status: 'done',
          description: 'review the diff',
          startedAt: '2026-09-23T11:59:10.000Z',
        },
      ],
    },
  ],
})

const TASKS = [
  makeTask({ id: 't1', title: 'Task One' }),
  makeTask({ id: 't2', title: 'Task Two', status: 'backlog' }),
]

afterEach(() => {
  vi.useRealTimers()
})

describe('<LanesPanel>', () => {
  it('renders the execute-lane header as used/cap', () => {
    render(<LanesPanel snapshot={WORKER_SNAPSHOT} tasks={TASKS} repos={REPOS} active />)
    expect(screen.getByLabelText('Lanes')).toBeInTheDocument()
    expect(screen.getByText('1/4')).toBeInTheDocument()
  })

  it('renders a worker row with its status, model, effort, repo and tokens', () => {
    render(<LanesPanel snapshot={WORKER_SNAPSHOT} tasks={TASKS} repos={REPOS} active />)
    expect(screen.getByText('Task One')).toBeInTheDocument()
    expect(screen.getByText('Executing')).toBeInTheDocument()
    expect(screen.getByText(/opus/)).toBeInTheDocument()
    expect(screen.getByText(/high/)).toBeInTheDocument()
    expect(screen.getByText(/caveman-full/)).toBeInTheDocument()
    expect(screen.getAllByText('zmrng').length).toBeGreaterThan(0)
    // tokensIn + tokensOut, thousands-grouped
    expect(screen.getByText(/1,540/)).toBeInTheDocument()
  })

  it('renders the queued tasks in promotion order under the lane header', () => {
    render(<LanesPanel snapshot={WORKER_SNAPSHOT} tasks={TASKS} repos={REPOS} active />)
    expect(screen.getByText(/queued/i)).toBeInTheDocument()
    expect(screen.getByText('Task Two')).toBeInTheDocument()
  })

  it('nests the subagent child rows inside their worker row', () => {
    render(<LanesPanel snapshot={WORKER_SNAPSHOT} tasks={TASKS} repos={REPOS} active />)
    const workerRow = screen.getByText('Task One').closest('li')!
    const subagent = screen.getByText('zmrng-qa')
    expect(workerRow).toContainElement(subagent)
    expect(workerRow).toContainElement(screen.getByText('run the suite'))
    expect(screen.getByText('code-reviewer')).toBeInTheDocument()
    expect(screen.getByText('review the diff')).toBeInTheDocument()
    // both subagent states are surfaced
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('done')).toBeInTheDocument()
  })

  it('groups an unlaned clarify worker separately from the lane holders', () => {
    const snapshot = makeSnapshot({
      execute: { cap: 4, holders: [], queued: [] },
      workers: [
        {
          taskId: 't3',
          model: 'sonnet',
          effort: 'medium',
          style: 'normal',
          startedAt: '2026-09-23T11:58:00.000Z',
          holdsLane: false,
          subagents: [],
        },
      ],
    })
    const tasks = [makeTask({ id: 't3', title: 'Clarify Me', status: 'clarify' })]
    render(<LanesPanel snapshot={snapshot} tasks={tasks} repos={REPOS} active />)
    // the clarify group is explicitly uncapped — it is not a second lane pool
    expect(screen.getByText(/uncapped/i)).toBeInTheDocument()
    expect(screen.getByText('Clarify Me')).toBeInTheDocument()
    // the row sits outside the execute pool, which still reads as empty
    expect(screen.getByText('0/4')).toBeInTheDocument()
  })

  it('renders a chat row labeled chat, with no task title', () => {
    const snapshot = makeSnapshot({
      chats: [
        {
          id: 'c1',
          model: 'opus',
          effort: 'low',
          style: 'normal',
          repoId: null,
          voice: false,
          startedAt: '2026-09-23T11:55:00.000Z',
          usage: USAGE,
        },
      ],
    })
    render(<LanesPanel snapshot={snapshot} tasks={TASKS} repos={REPOS} active />)
    expect(screen.getByText('chat')).toBeInTheDocument()
    expect(screen.getByText('Projects root')).toBeInTheDocument()
    expect(screen.getByText(/opus/)).toBeInTheDocument()
    expect(screen.getByText(/low/)).toBeInTheDocument()
    // a chat is not a task — no task title anywhere in the chat row
    expect(screen.queryByText('Task One')).toBeNull()
  })

  it('renders a terminal row with its shell and cwd', () => {
    const snapshot = makeSnapshot({
      terminals: [
        {
          id: 'term-1',
          shell: '/bin/bash',
          cwd: '/home/zc/dev',
          startedAt: '2026-09-23T11:50:00.000Z',
          attached: true,
        },
      ],
    })
    render(<LanesPanel snapshot={snapshot} tasks={[]} repos={REPOS} active />)
    expect(screen.getByText('/bin/bash')).toBeInTheDocument()
    expect(screen.getByText('/home/zc/dev')).toBeInTheDocument()
  })

  it('shows an empty state when nothing is running', () => {
    render(<LanesPanel snapshot={makeSnapshot()} tasks={TASKS} repos={REPOS} active />)
    expect(screen.getByText(/nothing running/i)).toBeInTheDocument()
  })

  it('shows the empty state before any snapshot has arrived', () => {
    render(<LanesPanel snapshot={null} tasks={TASKS} repos={REPOS} active />)
    expect(screen.getByText(/nothing running/i)).toBeInTheDocument()
  })

  it('ticks elapsed times once a second while the tab is active', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-23T12:00:00.000Z'))
    const snapshot = makeSnapshot({
      terminals: [
        {
          id: 'term-1',
          shell: '/bin/zsh',
          cwd: '/tmp',
          startedAt: '2026-09-23T12:00:00.000Z',
          attached: true,
        },
      ],
    })
    render(<LanesPanel snapshot={snapshot} tasks={[]} repos={REPOS} active />)
    expect(screen.getByText('0s')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(screen.getByText('5s')).toBeInTheDocument()
  })

  it('costs nothing while hidden — no tick when the tab is inactive', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-23T12:00:00.000Z'))
    const snapshot = makeSnapshot({
      terminals: [
        {
          id: 'term-1',
          shell: '/bin/zsh',
          cwd: '/tmp',
          startedAt: '2026-09-23T12:00:00.000Z',
          attached: true,
        },
      ],
    })
    render(<LanesPanel snapshot={snapshot} tasks={[]} repos={REPOS} active={false} />)
    expect(screen.getByText('0s')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    // still the render-time value — the hidden panel never re-rendered
    expect(screen.getByText('0s')).toBeInTheDocument()
  })

  it('catches the clock up when the tab becomes visible again', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-23T12:00:00.000Z'))
    const snapshot = makeSnapshot({
      terminals: [
        {
          id: 'term-1',
          shell: '/bin/zsh',
          cwd: '/tmp',
          startedAt: '2026-09-23T12:00:00.000Z',
          attached: true,
        },
      ],
    })
    const { rerender } = render(
      <LanesPanel snapshot={snapshot} tasks={[]} repos={REPOS} active={false} />,
    )
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(screen.getByText('0s')).toBeInTheDocument()

    // Showing the tab must not leave a half-minute-stale value on screen until
    // the first tick fires a second later.
    act(() => {
      rerender(<LanesPanel snapshot={snapshot} tasks={[]} repos={REPOS} active />)
    })
    expect(screen.getByText('30s')).toBeInTheDocument()
  })
})
