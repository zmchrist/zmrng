import { describe, it, expect } from 'vitest'
import {
  MAP_NODE_H,
  MAP_NODE_W,
  doneCount,
  edgeLine,
  formatRound,
  laneCards,
  layoutMap,
  mapEdges,
  mapHeader,
  mapSize,
  nodeBox,
  percentComplete,
  phaseColor,
  poolSummary,
  runStatusColor,
  stepLabel,
  ticketGlyph,
  type MapPosition,
} from '../src/loopMap'
import { LOOP_MAX_LANES, LOOP_MAX_ROUNDS } from '../src/types'
import type {
  LoopLane,
  LoopLoad,
  LoopRun,
  LoopRunStatus,
  LoopRunView,
  LoopTicket,
  LoopTicketState,
} from '../src/types'

const ZERO = { tokensIn: 0, tokensOut: 0, tokensCache: 0, costUsd: 0, turns: 0 }

function ticket(number: number, over: Partial<LoopTicket> = {}): LoopTicket {
  return {
    runId: 'r1',
    number,
    title: `Ticket ${number}`,
    body: '',
    url: `https://github.com/o/r/issues/${number}`,
    ghState: 'open',
    blockedBy: [],
    bar: 'beat the reference',
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
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

function run(over: Partial<LoopRun> = {}): LoopRun {
  return {
    id: 'r1',
    repoId: 'zmrng',
    epic: 100,
    title: 'Epic',
    status: 'running',
    prevStatus: null,
    lanes: 3,
    integBranch: 'gauntlet/r1/integ',
    integWorktree: '/w/integ',
    priority: [],
    prUrl: null,
    note: null,
    usage: ZERO,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

function lane(ticketNo: number, over: Partial<LoopLane> = {}): LoopLane {
  return {
    ticket: ticketNo,
    step: 'builder',
    model: 'opus',
    effort: 'high',
    activity: '',
    startedAt: '2026-10-01T00:00:00.000Z',
    waiting: false,
    ...over,
  }
}

function load(over: Partial<LoopLoad> = {}): LoopLoad {
  return {
    cores: 8,
    loadAvg1: 4.96,
    loadPerCore: 0.62,
    memTotalMb: 16384,
    memAvailableMb: 5222,
    maxLoadPerCore: 1,
    minFreeMemMb: 2048,
    allowsNewLane: true,
    reason: null,
    sampledAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

function view(over: Partial<LoopRunView> = {}): LoopRunView {
  return {
    run: run(),
    tickets: [],
    lanes: [],
    orchestratorAlive: true,
    orchestratorBusy: false,
    pool: { used: 2, max: 3 },
    load: load(),
    ...over,
  }
}

const byNumber = (ps: MapPosition[]) => new Map(ps.map((p) => [p.number, p]))

describe('layoutMap', () => {
  it('puts a chain A→B→C in columns 0, 1, 2', () => {
    const ps = byNumber(
      layoutMap([ticket(1), ticket(2, { blockedBy: [1] }), ticket(3, { blockedBy: [2] })]),
    )
    expect(ps.get(1)).toEqual({ number: 1, col: 0, row: 0 })
    expect(ps.get(2)).toEqual({ number: 2, col: 1, row: 0 })
    expect(ps.get(3)).toEqual({ number: 3, col: 2, row: 0 })
  })

  it('uses the LONGEST blocker chain for the column (a diamond plus a shortcut)', () => {
    // 1 → 2, 1 → 3, {2,3} → 4, and 1 → 4 directly: 4 still sits after 2 and 3.
    const ps = byNumber(
      layoutMap([
        ticket(4, { blockedBy: [2, 3, 1] }),
        ticket(3, { blockedBy: [1] }),
        ticket(2, { blockedBy: [1] }),
        ticket(1),
      ]),
    )
    expect(ps.get(1)).toMatchObject({ col: 0, row: 0 })
    expect(ps.get(2)).toMatchObject({ col: 1, row: 0 })
    expect(ps.get(3)).toMatchObject({ col: 1, row: 1 })
    expect(ps.get(4)).toMatchObject({ col: 2, row: 0 })
  })

  it('orders rows within a column by issue number and returns positions by number', () => {
    const ps = layoutMap([ticket(9), ticket(3), ticket(5)])
    expect(ps).toEqual([
      { number: 3, col: 0, row: 0 },
      { number: 5, col: 0, row: 1 },
      { number: 9, col: 0, row: 2 },
    ])
  })

  it('ignores blockers outside the map', () => {
    const ps = byNumber(layoutMap([ticket(1, { blockedBy: [77] }), ticket(2, { blockedBy: [1, 88] })]))
    expect(ps.get(1)).toMatchObject({ col: 0 })
    expect(ps.get(2)).toMatchObject({ col: 1 })
  })

  it('falls back to one column for everything on a cycle, without throwing', () => {
    const tickets = [
      ticket(1, { blockedBy: [2] }),
      ticket(2, { blockedBy: [1] }),
      ticket(3, { blockedBy: [1] }),
    ]
    expect(() => layoutMap(tickets)).not.toThrow()
    expect(layoutMap(tickets)).toEqual([
      { number: 1, col: 0, row: 0 },
      { number: 2, col: 0, row: 1 },
      { number: 3, col: 0, row: 2 },
    ])
  })

  it('treats a self-reference as no blocker rather than a cycle', () => {
    const ps = byNumber(layoutMap([ticket(1, { blockedBy: [1] }), ticket(2, { blockedBy: [1] })]))
    expect(ps.get(1)).toMatchObject({ col: 0 })
    expect(ps.get(2)).toMatchObject({ col: 1 })
  })

  it('returns nothing for an empty map', () => {
    expect(layoutMap([])).toEqual([])
  })
})

describe('mapEdges', () => {
  it('connects blocker → ticket only for blockers inside the map', () => {
    const edges = mapEdges([
      ticket(1, { blockedBy: [99] }),
      ticket(2, { blockedBy: [1] }),
      ticket(3, { blockedBy: [1, 2, 42] }),
    ])
    expect(edges).toEqual([
      { from: 1, to: 2 },
      { from: 1, to: 3 },
      { from: 2, to: 3 },
    ])
  })

  it('drops duplicate blockers and self-references', () => {
    expect(mapEdges([ticket(1, { blockedBy: [1] }), ticket(2, { blockedBy: [1, 1] })])).toEqual([
      { from: 1, to: 2 },
    ])
  })
})

describe('map geometry', () => {
  it('places nodes on a column/row grid with fixed node size', () => {
    const a = nodeBox({ number: 1, col: 0, row: 0 })
    const b = nodeBox({ number: 2, col: 1, row: 2 })
    expect(a.width).toBe(MAP_NODE_W)
    expect(a.height).toBe(MAP_NODE_H)
    expect(b.x).toBeGreaterThan(a.x + a.width)
    expect(b.y).toBeGreaterThan(a.y + 2 * a.height)
  })

  it('sizes the canvas to contain every node', () => {
    const ps = [
      { number: 1, col: 0, row: 0 },
      { number: 2, col: 2, row: 1 },
    ]
    const size = mapSize(ps)
    for (const p of ps) {
      const box = nodeBox(p)
      expect(size.width).toBeGreaterThanOrEqual(box.x + box.width)
      expect(size.height).toBeGreaterThanOrEqual(box.y + box.height)
    }
    expect(mapSize([])).toEqual({ width: 0, height: 0 })
  })

  it('draws a connector from the blocker’s right edge to the ticket’s left edge', () => {
    const from = { number: 1, col: 0, row: 0 }
    const to = { number: 2, col: 1, row: 1 }
    const a = nodeBox(from)
    const b = nodeBox(to)
    expect(edgeLine(from, to)).toEqual({
      x1: a.x + a.width,
      y1: a.y + a.height / 2,
      x2: b.x,
      y2: b.y + b.height / 2,
    })
  })
})

describe('progress', () => {
  it('percentComplete is 0 for an empty map', () => {
    expect(percentComplete([])).toBe(0)
    expect(doneCount([])).toEqual({ done: 0, total: 0 })
  })

  it('percentComplete excludes skipped tickets and rounds', () => {
    const ts = [
      ticket(1, { state: 'done' }),
      ticket(2, { state: 'todo' }),
      ticket(3, { state: 'executing' }),
      ticket(4, { state: 'skipped' }),
    ]
    expect(percentComplete(ts)).toBe(33)
    expect(doneCount(ts)).toEqual({ done: 1, total: 3 })
  })

  it('percentComplete is 0 when every ticket is skipped (no divide by zero)', () => {
    expect(percentComplete([ticket(1, { state: 'skipped' })])).toBe(0)
  })

  it('mapHeader reads "N of M · P%"', () => {
    const ts = [
      ticket(1, { state: 'done' }),
      ticket(2, { state: 'done' }),
      ticket(3, { state: 'todo' }),
      ticket(4, { state: 'needs-human' }),
      ticket(5, { state: 'skipped' }),
    ]
    expect(mapHeader(ts)).toBe('2 of 4 · 50%')
  })
})

describe('ticketGlyph', () => {
  const cases: Array<[LoopTicketState, ReturnType<typeof ticketGlyph>]> = [
    ['done', 'checked'],
    ['todo', 'unchecked'],
    ['blocked', 'unchecked'],
    ['executing', 'active'],
    ['reviewing', 'active'],
    ['validating', 'active'],
    ['finishing', 'active'],
    ['folding', 'active'],
    ['waiting', 'active'],
    ['needs-human', 'warn'],
    ['skipped', 'skipped'],
  ]
  it.each(cases)('%s → %s', (state, glyph) => {
    expect(ticketGlyph(state)).toBe(glyph)
  })
})

describe('stepLabel / phaseColor', () => {
  it('labels each step and its matching ticket state the same way', () => {
    expect(stepLabel('builder')).toBe('Executing')
    expect(stepLabel('executing')).toBe('Executing')
    expect(stepLabel('critic')).toBe('Reviewing')
    expect(stepLabel('reviewing')).toBe('Reviewing')
    expect(stepLabel('validate')).toBe('Validating')
    expect(stepLabel('validating')).toBe('Validating')
    expect(stepLabel('finish')).toBe('Finishing')
    expect(stepLabel('finishing')).toBe('Finishing')
    expect(stepLabel('fold')).toBe('Folding')
    expect(stepLabel('folding')).toBe('Folding')
    expect(stepLabel('waiting')).toBe('Waiting')
  })

  it('labels the resting states too', () => {
    expect(stepLabel('todo')).toBe('To do')
    expect(stepLabel('blocked')).toBe('Blocked')
    expect(stepLabel('done')).toBe('Done')
    expect(stepLabel('needs-human')).toBe('Needs human')
    expect(stepLabel('skipped')).toBe('Skipped')
  })

  it('colors each phase with an existing design token', () => {
    expect(phaseColor('executing')).toBe('var(--status-executing)')
    expect(phaseColor('builder')).toBe('var(--status-executing)')
    expect(phaseColor('reviewing')).toBe('var(--actor-code-reviewer)')
    expect(phaseColor('validating')).toBe('var(--status-validating)')
    expect(phaseColor('finishing')).toBe('var(--status-review)')
    expect(phaseColor('folding')).toBe('var(--accent)')
    expect(phaseColor('waiting')).toBe('var(--status-blocked)')
    expect(phaseColor('done')).toBe('var(--status-done)')
    expect(phaseColor('needs-human')).toBe('var(--status-blocked)')
  })

  it('colors every run status with a var(--*) token', () => {
    const statuses: LoopRunStatus[] = [
      'draft',
      'running',
      'paused',
      'finalizing',
      'complete',
      'blocked',
      'stale',
      'archived',
    ]
    for (const s of statuses) expect(runStatusColor(s)).toMatch(/^var\(--[a-z-]+\)$/)
    expect(runStatusColor('running')).toBe('var(--status-executing)')
    expect(runStatusColor('complete')).toBe('var(--status-done)')
  })
})

describe('formatRound', () => {
  it(`formats round r/${LOOP_MAX_ROUNDS}`, () => {
    expect(formatRound(1)).toBe(`round 1/${LOOP_MAX_ROUNDS}`)
    expect(formatRound(6)).toBe('round 6/6')
    expect(formatRound(-1)).toBe('round 0/6')
  })
})

describe('laneCards', () => {
  it('orders cards by lane order, joins each with its ticket, and pads idle slots to the lane count', () => {
    const cards = laneCards(
      view({
        run: run({ lanes: 3 }),
        tickets: [ticket(4, { round: 2, usage: { ...ZERO, tokensIn: 1000, tokensOut: 234 } }), ticket(7)],
        lanes: [lane(7, { step: 'critic' }), lane(4, { step: 'builder' })],
      }),
    )
    expect(cards).toHaveLength(3)
    expect(cards[0]).toMatchObject({ kind: 'lane', phase: 'reviewing', ticket: { number: 7 } })
    expect(cards[1]).toMatchObject({
      kind: 'lane',
      phase: 'executing',
      round: 'round 2/6',
      tokens: 1234,
      ticket: { number: 4 },
    })
    expect(cards[2]).toEqual({ kind: 'idle', slot: 2 })
  })

  it('shows a waiting lane as waiting whatever its step', () => {
    const [card] = laneCards(view({ tickets: [ticket(1)], lanes: [lane(1, { step: 'validate', waiting: true })] }))
    expect(card).toMatchObject({ kind: 'lane', phase: 'waiting' })
  })

  it('keeps a lane whose ticket is missing from the map, with no ticket joined', () => {
    const [card] = laneCards(view({ run: run({ lanes: 1 }), tickets: [], lanes: [lane(5)] }))
    expect(card).toMatchObject({ kind: 'lane', ticket: null, tokens: 0, round: 'round 0/6' })
  })

  it('never pads above the pool cap, and never pads below the live lanes', () => {
    expect(laneCards(view({ run: run({ lanes: 9 }) }))).toHaveLength(LOOP_MAX_LANES)
    const live = laneCards(view({ run: run({ lanes: 0 }), tickets: [ticket(1)], lanes: [lane(1)] }))
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ kind: 'lane' })
  })
})

describe('poolSummary', () => {
  it('formats pool, load per core and free memory', () => {
    expect(poolSummary(view())).toEqual({
      text: 'Pool 2/3 · load 0.62/core · 5.1 GB free',
      gateClosed: false,
      reason: null,
    })
  })

  it('reports the gate closed when the sample refuses a new lane', () => {
    const s = poolSummary(
      view({ load: load({ allowsNewLane: false, reason: 'load 1.40/core over 1.00', loadPerCore: 1.4 }) }),
    )
    expect(s.gateClosed).toBe(true)
    expect(s.reason).toBe('load 1.40/core over 1.00')
    expect(s.text).toBe('Pool 2/3 · load 1.40/core · 5.1 GB free')
  })

  it('degrades to the pool alone before the first load sample', () => {
    expect(poolSummary(view({ load: null }))).toEqual({ text: 'Pool 2/3', gateClosed: false, reason: null })
  })
})
