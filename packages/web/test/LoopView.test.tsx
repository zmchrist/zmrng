import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { LoopView, type LoopClient } from '../src/components/LoopView'
import type {
  LoopEvent,
  LoopLane,
  LoopLoad,
  LoopRun,
  LoopRunView,
  LoopTicket,
  RepoTarget,
} from '../src/types'

const openExternal = vi.fn()
vi.mock('../src/openExternal', () => ({
  openExternal: (url: string) => openExternal(url),
}))

const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const ago = (s: number) => new Date(NOW - s * 1000).toISOString()
const ZERO = { tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0, turns: 0 }

const REPOS: RepoTarget[] = [
  { id: 'zmrng', label: 'zmrng', path: '/repos/zmrng', defaultBranch: 'main' },
  { id: 'other', label: 'Other app', path: '/repos/other', defaultBranch: 'main' },
]

function ticket(number: number, title: string, over: Partial<LoopTicket> = {}): LoopTicket {
  return {
    runId: 'r1',
    number,
    title,
    body: '',
    url: `https://github.com/o/r/issues/${number}`,
    ghState: 'open',
    blockedBy: [],
    bar: 'the reference',
    state: 'todo',
    step: null,
    round: 0,
    lastGap: null,
    branch: null,
    worktree: null,
    foldSha: null,
    question: null,
    note: null,
    usage: ZERO,
    startedAt: null,
    stepStartedAt: null,
    updatedAt: ago(0),
    ...over,
  }
}

function makeRun(over: Partial<LoopRun> = {}): LoopRun {
  return {
    id: 'r1',
    repoId: 'zmrng',
    epic: 12,
    title: 'Gauntlet epic',
    status: 'running',
    prevStatus: null,
    lanes: 3,
    integBranch: 'gauntlet/r1/integ',
    integWorktree: '/w/integ',
    priority: [],
    prUrl: null,
    note: null,
    usage: ZERO,
    createdAt: ago(3600),
    updatedAt: ago(0),
    ...over,
  }
}

function lane(over: Partial<LoopLane>): LoopLane {
  return {
    ticket: 0,
    step: 'builder',
    model: 'opus',
    effort: 'high',
    activity: '',
    startedAt: ago(0),
    waiting: false,
    ...over,
  }
}

const LOAD: LoopLoad = {
  cores: 8,
  loadAvg1: 4.96,
  loadPerCore: 0.62,
  memTotalMb: 16384,
  memAvailableMb: 5222,
  maxLoadPerCore: 1,
  minFreeMemMb: 2048,
  allowsNewLane: true,
  reason: null,
  sampledAt: ago(0),
}

function makeView(over: Partial<LoopRunView> = {}): LoopRunView {
  return {
    run: makeRun(),
    tickets: [
      ticket(1, 'Parse the bar', { state: 'done', ghState: 'closed' }),
      ticket(2, 'Blocked-by fallback', { state: 'done', blockedBy: [1] }),
      ticket(3, 'Lane pool', {
        state: 'executing',
        step: 'builder',
        round: 2,
        blockedBy: [1],
        usage: { ...ZERO, tokensIn: 1000, tokensOut: 234 },
      }),
      ticket(4, 'Load gate', {
        state: 'waiting',
        step: 'critic',
        round: 1,
        blockedBy: [2, 3],
        question: 'Which threshold wins?',
      }),
      ticket(5, 'Dropped idea', { state: 'skipped' }),
    ],
    lanes: [
      lane({ ticket: 3, step: 'builder', activity: 'Edit src/loop.ts', startedAt: ago(125) }),
      lane({ ticket: 4, step: 'critic', activity: 'Read the bar', startedAt: ago(10), waiting: true }),
    ],
    orchestratorAlive: true,
    orchestratorBusy: false,
    pool: { used: 2, max: 3 },
    load: LOAD,
    ...over,
  }
}

function chat(id: number, role: 'operator' | 'orchestrator' | 'tool' | 'loop', text: string): LoopEvent {
  return {
    id,
    runId: 'r1',
    ticket: null,
    kind: 'chat',
    payload: role === 'tool' ? { role, tool: 'Bash', summary: text } : { role, text },
    createdAt: ago(0),
  }
}

function fakeClient(): { [K in keyof LoopClient]: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(async () => makeView()),
    pause: vi.fn(async () => makeView()),
    resume: vi.fn(async () => makeView()),
    archive: vi.fn(async () => ({ ok: true })),
    setLanes: vi.fn(async () => makeView()),
    chat: vi.fn(async () => ({ ok: true })),
    stopTicket: vi.fn(async () => makeView()),
  }
}

interface RenderOpts {
  view?: LoopRunView | null
  openRunId?: string | null
  runs?: LoopRun[]
  events?: LoopEvent[]
  partial?: string
  active?: boolean
  loadError?: string | null
}

function renderLoop(opts: RenderOpts = {}) {
  const client = fakeClient()
  const onOpenRun = vi.fn()
  const onCreate = vi.fn(async () => undefined)
  const onView = vi.fn()
  const view = opts.view === undefined ? makeView() : opts.view
  const props = {
    runs: opts.runs ?? [makeRun()],
    openRunId: opts.openRunId === undefined ? (view?.run.id ?? null) : opts.openRunId,
    view,
    events: opts.events ?? [],
    partial: opts.partial ?? '',
    loadError: opts.loadError ?? null,
    repos: REPOS,
    active: opts.active ?? true,
    onOpenRun,
    onCreate,
    onView,
    client: client as unknown as LoopClient,
  }
  const utils = render(<LoopView {...props} />)
  return { ...utils, client, onOpenRun, onCreate, onView, props }
}

/** Let an awaited handler's promise settle inside act(). */
async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  // Fake only the clock + interval: React Testing Library still needs real
  // setTimeout, and the elapsed tick is a 1s setInterval.
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  openExternal.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('<LoopView> with a run open', () => {
  it('renders the three regions: orchestrator chat, lanes and the ticket map', () => {
    renderLoop()
    expect(screen.getByRole('region', { name: 'Orchestrator' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Lanes' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Ticket map' })).toBeInTheDocument()
  })

  it('the map header reads "2 of 4 · 50%" (skipped tickets excluded)', () => {
    renderLoop()
    const map = screen.getByRole('region', { name: 'Ticket map' })
    expect(within(map).getByText('2 of 4 · 50%')).toBeInTheDocument()
    expect(within(map).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
  })

  it('done tickets render a checked checkbox, open ones unchecked, none operator-toggleable', () => {
    renderLoop()
    const map = screen.getByRole('region', { name: 'Ticket map' })
    expect(within(map).getByRole('checkbox', { name: '#1 Parse the bar' })).toBeChecked()
    expect(within(map).getByRole('checkbox', { name: '#2 Blocked-by fallback' })).toBeChecked()
    expect(within(map).getByRole('checkbox', { name: '#3 Lane pool' })).not.toBeChecked()
    expect(within(map).getByRole('checkbox', { name: '#4 Load gate' })).not.toBeChecked()
    expect(within(map).getByRole('checkbox', { name: '#5 Dropped idea' })).not.toBeChecked()
    expect(within(map).getAllByRole('checkbox', { checked: true })).toHaveLength(2)
    for (const box of within(map).getAllByRole('checkbox')) {
      expect(box).toHaveAttribute('aria-readonly', 'true')
    }
    // Clicking a box changes nothing — the map reflects the server, it is not a control.
    fireEvent.click(within(map).getByRole('checkbox', { name: '#3 Lane pool' }))
    expect(within(map).getByRole('checkbox', { name: '#3 Lane pool' })).not.toBeChecked()
  })

  it('labels each map node with its state, and a needs-human node with its note', () => {
    const view = makeView()
    view.tickets[4] = ticket(5, 'No bar here', { state: 'needs-human', note: 'ticket has no bar' })
    renderLoop({ view })
    const map = screen.getByRole('region', { name: 'Ticket map' })
    expect(within(map).getAllByText('Done')).toHaveLength(2)
    expect(within(map).getByText('Needs human')).toBeInTheDocument()
    expect(within(map).getByText('ticket has no bar')).toBeInTheDocument()
  })

  it('draws one straight connector per in-map blocker link', () => {
    renderLoop()
    const map = screen.getByRole('region', { name: 'Ticket map' })
    // 1→2, 1→3, 2→4, 3→4
    expect(map.querySelectorAll('svg line')).toHaveLength(4)
  })

  it('a lane card shows its ticket, step, round, tokens, elapsed, model and activity', () => {
    renderLoop()
    const lanes = screen.getByRole('region', { name: 'Lanes' })
    const card = within(lanes).getByRole('button', { name: '#3 Lane pool' }).closest('li')!
    const c = within(card)
    expect(c.getByText('Executing')).toBeInTheDocument()
    expect(c.getByText('round 2/6')).toBeInTheDocument()
    expect(c.getByText('1,234 tok')).toBeInTheDocument()
    expect(c.getByText('2m 05s')).toBeInTheDocument()
    expect(c.getByText('opus · high')).toBeInTheDocument()
    expect(c.getByText('Edit src/loop.ts')).toBeInTheDocument()
  })

  it('a waiting lane shows its question', () => {
    renderLoop()
    const lanes = screen.getByRole('region', { name: 'Lanes' })
    const card = within(lanes).getByRole('button', { name: '#4 Load gate' }).closest('li')!
    expect(within(card).getByText('Waiting')).toBeInTheDocument()
    expect(within(card).getByText('Which threshold wins?')).toBeInTheDocument()
  })

  it('pads the lane row with idle slots up to the run’s lane target', () => {
    renderLoop()
    expect(within(screen.getByRole('region', { name: 'Lanes' })).getAllByText('idle lane')).toHaveLength(1)
  })

  it('the ticket title on a lane card opens the issue externally', () => {
    renderLoop()
    const lanes = screen.getByRole('region', { name: 'Lanes' })
    fireEvent.click(within(lanes).getByRole('button', { name: '#3 Lane pool' }))
    expect(openExternal).toHaveBeenCalledWith('https://github.com/o/r/issues/3')
  })

  it('the elapsed clock ticks only while the Loop tab is active', () => {
    const { rerender, props } = renderLoop()
    const lanes = () => screen.getByRole('region', { name: 'Lanes' })
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(within(lanes()).getByText('2m 08s')).toBeInTheDocument()
    rerender(<LoopView {...props} active={false} />)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(within(lanes()).getByText('2m 08s')).toBeInTheDocument()
  })

  it('Stop asks first, then stops that ticket', async () => {
    const { client } = renderLoop()
    fireEvent.click(screen.getByRole('button', { name: 'Stop #3' }))
    expect(client.stopTicket).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel stop' }))
    expect(screen.queryByRole('button', { name: 'Confirm stop #3' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop #3' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stop #3' }))
    await flush()
    expect(client.stopTicket).toHaveBeenCalledWith('r1', 3)
  })

  it('shows the pool summary, and a "picks paused: high load" chip while the gate is closed', () => {
    const closed = makeView({
      load: { ...LOAD, loadPerCore: 1.4, allowsNewLane: false, reason: 'load 1.40/core over 1.00' },
    })
    renderLoop({ view: closed })
    const lanes = screen.getByRole('region', { name: 'Lanes' })
    expect(within(lanes).getByText('Pool 2/3 · load 1.40/core · 5.1 GB free')).toBeInTheDocument()
    const chip = within(lanes).getByText('picks paused: high load')
    expect(chip).toHaveAttribute('title', 'load 1.40/core over 1.00')
  })

  it('shows no chip while the gate is open', () => {
    renderLoop()
    expect(screen.queryByText('picks paused: high load')).toBeNull()
    expect(screen.getByText('Pool 2/3 · load 0.62/core · 5.1 GB free')).toBeInTheDocument()
  })

  it('header: Pause on a running run, Start on a draft or paused run', async () => {
    const { client } = renderLoop()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await flush()
    expect(client.pause).toHaveBeenCalledWith('r1')
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
  })

  it('header: Start on a draft run reports the returned view', async () => {
    const { client, onView } = renderLoop({ view: makeView({ run: makeRun({ status: 'draft' }) }) })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await flush()
    expect(client.start).toHaveBeenCalledWith('r1')
    expect(onView).toHaveBeenCalled()
  })

  it('header: the lane-count select sets the run’s lane target (0..3)', async () => {
    const { client } = renderLoop()
    const select = screen.getByRole('combobox', { name: 'Lane count' })
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['0', '1', '2', '3'])
    expect(select).toHaveValue('3')
    fireEvent.change(select, { target: { value: '2' } })
    await flush()
    expect(client.setLanes).toHaveBeenCalledWith('r1', 2)
  })

  it('header: Resume only on a stale run', async () => {
    const { client } = renderLoop({ view: makeView({ run: makeRun({ status: 'stale' }) }) })
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await flush()
    expect(client.resume).toHaveBeenCalledWith('r1')
  })

  it('header: no Resume on a live run', () => {
    renderLoop()
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  })

  it('header: Archive asks first, then archives and closes the run', async () => {
    const { client, onOpenRun } = renderLoop()
    fireEvent.click(screen.getByRole('button', { name: 'Archive run' }))
    expect(client.archive).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm archive' }))
    await flush()
    expect(client.archive).toHaveBeenCalledWith('r1')
    expect(onOpenRun).toHaveBeenCalledWith(null)
  })

  it('header: shows the run title and status, and goes back to the run picker', () => {
    const { onOpenRun } = renderLoop()
    expect(screen.getByRole('heading', { name: '#12 Gauntlet epic' })).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'All runs' }))
    expect(onOpenRun).toHaveBeenCalledWith(null)
  })

  it('surfaces a failed action instead of swallowing it', async () => {
    const { client } = renderLoop()
    client.pause.mockRejectedValueOnce(new Error('run is not running'))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('run is not running')
  })

  it('shows a loading state while the open run’s view has not arrived', () => {
    renderLoop({ view: null, openRunId: 'r1' })
    expect(screen.getByText('Loading run…')).toBeInTheDocument()
  })

  it('shows why the open run failed to load, with a way back to the picker', () => {
    const { onOpenRun } = renderLoop({ view: null, openRunId: 'r1', loadError: 'run not found' })
    expect(screen.queryByText('Loading run…')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('run not found')
    fireEvent.click(screen.getByRole('button', { name: 'All runs' }))
    expect(onOpenRun).toHaveBeenCalledWith(null)
  })
})

describe('<LoopView> orchestrator chat', () => {
  it('renders operator and orchestrator bubbles, tool and loop notes, and the live partial', () => {
    renderLoop({
      events: [
        chat(1, 'operator', 'how many lanes?'),
        chat(2, 'tool', 'curl GET /api/loop/load'),
        chat(3, 'orchestrator', 'two lanes — load is low'),
        chat(4, 'loop', '#3 LOSE: gap is X'),
      ],
      partial: 'raising to thr',
    })
    const pane = within(screen.getByRole('region', { name: 'Orchestrator' }))
    expect(pane.getByText('how many lanes?')).toBeInTheDocument()
    expect(pane.getByText('two lanes — load is low')).toBeInTheDocument()
    expect(pane.getByText('curl GET /api/loop/load')).toBeInTheDocument()
    expect(pane.getByText('#3 LOSE: gap is X')).toBeInTheDocument()
    expect(pane.getByText('raising to thr')).toBeInTheDocument()
  })

  it('Enter sends to the orchestrator, Shift+Enter does not', async () => {
    const { client } = renderLoop()
    const box = screen.getByRole('textbox', { name: 'Message the orchestrator' })
    fireEvent.change(box, { target: { value: 'go two lanes' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(client.chat).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    await flush()
    expect(client.chat).toHaveBeenCalledWith('r1', 'go two lanes')
    expect(box).toHaveValue('')
  })

  it('keeps the draft and shows the error when a send fails', async () => {
    const { client } = renderLoop()
    client.chat.mockRejectedValueOnce(new Error('orchestrator unavailable'))
    const box = screen.getByRole('textbox', { name: 'Message the orchestrator' })
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await flush()
    expect(box).toHaveValue('hello')
    expect(within(screen.getByRole('region', { name: 'Orchestrator' })).getByRole('alert')).toHaveTextContent(
      'orchestrator unavailable',
    )
  })

  it('Send is disabled for a blank draft', () => {
    renderLoop()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })
})

describe('<LoopView> with no run open', () => {
  it('lists the runs with their status and opens one', () => {
    const { onOpenRun } = renderLoop({
      view: null,
      openRunId: null,
      runs: [makeRun(), makeRun({ id: 'r2', epic: 30, title: 'Second epic', status: 'complete' })],
    })
    expect(screen.getByText('Complete')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /#30 Second epic/ }))
    expect(onOpenRun).toHaveBeenCalledWith('r2')
  })

  it('the new-run form submits {repoId, epic} with no lane count', async () => {
    const { onCreate } = renderLoop({ view: null, openRunId: null, runs: [] })
    expect(screen.queryByRole('combobox', { name: /lane/i })).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: 'Repo' }), { target: { value: 'other' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Epic issue #' }), { target: { value: '42' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create run' }))
    await flush()
    expect(onCreate).toHaveBeenCalledWith({ repoId: 'other', epic: 42 })
  })

  it('defaults the repo to the first registered one', async () => {
    const { onCreate } = renderLoop({ view: null, openRunId: null, runs: [] })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Epic issue #' }), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create run' }))
    await flush()
    expect(onCreate).toHaveBeenCalledWith({ repoId: 'zmrng', epic: 7 })
  })

  it('Create run stays disabled until the epic is a positive whole number', () => {
    renderLoop({ view: null, openRunId: null, runs: [] })
    const epic = screen.getByRole('spinbutton', { name: 'Epic issue #' })
    const create = screen.getByRole('button', { name: 'Create run' })
    expect(create).toBeDisabled()
    fireEvent.change(epic, { target: { value: '0' } })
    expect(create).toBeDisabled()
    fireEvent.change(epic, { target: { value: '2.5' } })
    expect(create).toBeDisabled()
    fireEvent.change(epic, { target: { value: '3' } })
    expect(create).toBeEnabled()
  })

  it('shows the server’s error when creating a run fails', async () => {
    const { onCreate } = renderLoop({ view: null, openRunId: null, runs: [] })
    onCreate.mockRejectedValueOnce(new Error('repo has no GitHub origin'))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Epic issue #' }), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create run' }))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('repo has no GitHub origin')
  })
})
