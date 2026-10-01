// Pure, React-free derivations feeding the Loop tab: the ticket-map DAG layout
// and its geometry, progress, per-state glyphs/labels/colors, the lane cards and
// the lane-pool summary line. No DOM, no fetch — unit-tested directly, like
// `laneRows.ts` (whose `formatTokens`/`formatElapsed` the Loop components reuse).

import { LOOP_MAX_LANES, LOOP_MAX_ROUNDS } from './types'
import type {
  LoopLane,
  LoopRunStatus,
  LoopRunView,
  LoopStep,
  LoopTicket,
  LoopTicketState,
} from './types'

// ---- map layout -----------------------------------------------------------

/** Where one ticket sits in the layered map: `col` = blocker depth, `row` = order. */
export interface MapPosition {
  number: number
  col: number
  row: number
}

/** A straight connector from a blocker to the ticket it blocks. */
export interface MapEdge {
  from: number
  to: number
}

/** A ticket's blockers that are themselves in the map — deduped, sorted, no self-reference. */
function inMapBlockers(t: LoopTicket, inMap: ReadonlySet<number>): number[] {
  const out = new Set<number>()
  for (const b of t.blockedBy) if (b !== t.number && inMap.has(b)) out.add(b)
  return [...out].sort((a, b) => a - b)
}

/**
 * Lay the map out as a layered DAG. A ticket's column is the length of its
 * LONGEST in-map blocker chain (no blockers → 0), so every connector points
 * rightwards; rows order each column by issue number. Blockers outside the map
 * are ignored here (they gate picking server-side, but there is no node to draw).
 * A dependency cycle cannot be layered — every ticket then falls back to column
 * 0 rather than throwing. Positions are returned sorted by issue number.
 */
export function layoutMap(tickets: LoopTicket[]): MapPosition[] {
  const numbers = [...new Set(tickets.map((t) => t.number))].sort((a, b) => a - b)
  const inMap = new Set(numbers)
  const blockers = new Map<number, number[]>()
  for (const t of tickets) blockers.set(t.number, inMapBlockers(t, inMap))

  const depth = new Map<number, number>()
  const visiting = new Set<number>()
  let cyclic = false
  const visit = (n: number): number => {
    const known = depth.get(n)
    if (known !== undefined) return known
    if (visiting.has(n)) {
      cyclic = true
      return 0
    }
    visiting.add(n)
    let d = 0
    for (const b of blockers.get(n) ?? []) d = Math.max(d, visit(b) + 1)
    visiting.delete(n)
    depth.set(n, d)
    return d
  }
  for (const n of numbers) visit(n)

  const nextRow = new Map<number, number>()
  return numbers.map((number) => {
    const col = cyclic ? 0 : (depth.get(number) ?? 0)
    const row = nextRow.get(col) ?? 0
    nextRow.set(col, row + 1)
    return { number, col, row }
  })
}

/** blocker → ticket connectors, only where both ends are in the map. */
export function mapEdges(tickets: LoopTicket[]): MapEdge[] {
  const inMap = new Set(tickets.map((t) => t.number))
  const sorted = [...tickets].sort((a, b) => a.number - b.number)
  return sorted.flatMap((t) => inMapBlockers(t, inMap).map((from) => ({ from, to: t.number })))
}

// ---- map geometry (px) -----------------------------------------------------
// Nodes have a FIXED size so connectors can meet them exactly; the component
// renders these numbers as inline positions (the sanctioned dynamic-value case).

export const MAP_NODE_W = 220
export const MAP_NODE_H = 60
export const MAP_COL_GAP = 56
export const MAP_ROW_GAP = 14
export const MAP_PAD = 12

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The node rectangle for one position. */
export function nodeBox(p: MapPosition): Box {
  return {
    x: MAP_PAD + p.col * (MAP_NODE_W + MAP_COL_GAP),
    y: MAP_PAD + p.row * (MAP_NODE_H + MAP_ROW_GAP),
    width: MAP_NODE_W,
    height: MAP_NODE_H,
  }
}

/** The canvas size that contains every node (plus padding); 0×0 when empty. */
export function mapSize(positions: MapPosition[]): { width: number; height: number } {
  if (positions.length === 0) return { width: 0, height: 0 }
  let width = 0
  let height = 0
  for (const p of positions) {
    const b = nodeBox(p)
    width = Math.max(width, b.x + b.width + MAP_PAD)
    height = Math.max(height, b.y + b.height + MAP_PAD)
  }
  return { width, height }
}

/** A straight connector: the blocker's right-middle to the ticket's left-middle. */
export function edgeLine(
  from: MapPosition,
  to: MapPosition,
): { x1: number; y1: number; x2: number; y2: number } {
  const a = nodeBox(from)
  const b = nodeBox(to)
  return { x1: a.x + a.width, y1: a.y + a.height / 2, x2: b.x, y2: b.y + b.height / 2 }
}

// ---- progress -----------------------------------------------------------------

/** Done tickets vs. the map's size; skipped tickets are out of the map's scope. */
export function doneCount(tickets: LoopTicket[]): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const t of tickets) {
    if (t.state === 'skipped') continue
    total += 1
    if (t.state === 'done') done += 1
  }
  return { done, total }
}

/** done ÷ non-skipped × 100, rounded; 0 for an empty (or all-skipped) map. */
export function percentComplete(tickets: LoopTicket[]): number {
  const { done, total } = doneCount(tickets)
  return total === 0 ? 0 : Math.round((done / total) * 100)
}

/** The map header, e.g. `2 of 4 · 50%`. */
export function mapHeader(tickets: LoopTicket[]): string {
  const { done, total } = doneCount(tickets)
  return `${done} of ${total} · ${percentComplete(tickets)}%`
}

// ---- per-state presentation -----------------------------------------------------

export type TicketGlyph = 'checked' | 'unchecked' | 'active' | 'warn' | 'skipped'

const GLYPH: Record<LoopTicketState, TicketGlyph> = {
  done: 'checked',
  todo: 'unchecked',
  blocked: 'unchecked',
  executing: 'active',
  reviewing: 'active',
  validating: 'active',
  finishing: 'active',
  folding: 'active',
  waiting: 'active',
  'needs-human': 'warn',
  skipped: 'skipped',
}

/** The map node's checkbox glyph for a ticket state. */
export function ticketGlyph(state: LoopTicketState): TicketGlyph {
  return GLYPH[state]
}

/** What a live lane is doing — a step, or parked on a question. */
export type LanePhase = 'executing' | 'reviewing' | 'validating' | 'finishing' | 'folding' | 'waiting'

/** Each fresh-agent step maps 1:1 onto the ticket state it runs in. */
const STEP_PHASE: Record<LoopStep, LanePhase> = {
  builder: 'executing',
  critic: 'reviewing',
  validate: 'validating',
  finish: 'finishing',
  fold: 'folding',
}

/** Normalize a step OR a ticket state to the ticket-state vocabulary. */
function asState(s: LoopStep | LoopTicketState): LoopTicketState {
  return s in STEP_PHASE ? STEP_PHASE[s as LoopStep] : (s as LoopTicketState)
}

const STATE_LABEL: Record<LoopTicketState, string> = {
  todo: 'To do',
  blocked: 'Blocked',
  executing: 'Executing',
  reviewing: 'Reviewing',
  validating: 'Validating',
  finishing: 'Finishing',
  folding: 'Folding',
  waiting: 'Waiting',
  done: 'Done',
  'needs-human': 'Needs human',
  skipped: 'Skipped',
}

/** Human label for a step or a ticket state (a step reads as the state it runs in). */
export function stepLabel(s: LoopStep | LoopTicketState): string {
  return STATE_LABEL[asState(s)]
}

/** Existing design tokens only — no `--loop-*` token is needed to express a state. */
const STATE_COLOR: Record<LoopTicketState, string> = {
  todo: 'var(--status-backlog)',
  blocked: 'var(--status-backlog)',
  executing: 'var(--status-executing)',
  reviewing: 'var(--actor-code-reviewer)',
  validating: 'var(--status-validating)',
  finishing: 'var(--status-review)',
  folding: 'var(--accent)',
  waiting: 'var(--status-blocked)',
  done: 'var(--status-done)',
  'needs-human': 'var(--status-blocked)',
  skipped: 'var(--status-archived)',
}

/** Pill color (a `var(--*)` token) for a step or ticket state. */
export function phaseColor(s: LoopStep | LoopTicketState): string {
  return STATE_COLOR[asState(s)]
}

export const RUN_STATUS_LABEL: Record<LoopRunStatus, string> = {
  draft: 'Draft',
  running: 'Running',
  paused: 'Paused',
  finalizing: 'Finalizing',
  complete: 'Complete',
  blocked: 'Blocked',
  stale: 'Stale',
  archived: 'Archived',
}

const RUN_STATUS_COLOR: Record<LoopRunStatus, string> = {
  draft: 'var(--status-backlog)',
  running: 'var(--status-executing)',
  paused: 'var(--status-clarify)',
  finalizing: 'var(--status-validating)',
  complete: 'var(--status-done)',
  blocked: 'var(--status-blocked)',
  stale: 'var(--status-failed)',
  archived: 'var(--status-archived)',
}

/** Pill color (a `var(--*)` token) for a run status. */
export function runStatusColor(s: LoopRunStatus): string {
  return RUN_STATUS_COLOR[s]
}

/** The gauntlet round against the fuse, e.g. `round 2/6`. */
export function formatRound(round: number): string {
  return `round ${Math.max(0, round)}/${LOOP_MAX_ROUNDS}`
}

// ---- lanes ------------------------------------------------------------------------

/** One lane window: a live lane joined with its ticket, or an idle slot. */
export type LaneCard =
  | {
      kind: 'lane'
      lane: LoopLane
      /** null when the lane's ticket is not (or no longer) in the map. */
      ticket: LoopTicket | null
      phase: LanePhase
      /** `round r/6`. */
      round: string
      /** tokensIn + tokensOut, cache excluded (the Lanes-tab convention). */
      tokens: number
    }
  | { kind: 'idle'; slot: number }

/**
 * The lane windows for a run, in the server's lane order, padded with idle
 * slots up to the run's target (`run.lanes`) — never above the pool cap, and
 * never dropping a live lane (an in-flight step outlives a lowered target).
 */
export function laneCards(view: LoopRunView): LaneCard[] {
  const byNumber = new Map(view.tickets.map((t) => [t.number, t]))
  const cards: LaneCard[] = view.lanes.map((lane) => {
    const ticket = byNumber.get(lane.ticket) ?? null
    return {
      kind: 'lane',
      lane,
      ticket,
      phase: lane.waiting ? 'waiting' : STEP_PHASE[lane.step],
      round: formatRound(ticket?.round ?? 0),
      tokens: ticket ? ticket.usage.tokensIn + ticket.usage.tokensOut : 0,
    }
  })
  const slots = Math.min(LOOP_MAX_LANES, Math.max(view.run.lanes, view.lanes.length))
  for (let slot = cards.length; slot < slots; slot++) cards.push({ kind: 'idle', slot })
  return cards
}

/** The lanes header line plus the load-gate state behind its "picks paused" chip. */
export interface PoolSummary {
  /** e.g. `Pool 2/3 · load 0.62/core · 5.1 GB free`, or `Pool 2/3` before a sample. */
  text: string
  /** True while the server's load gate refuses new picks. */
  gateClosed: boolean
  /** Which threshold tripped (the chip's tooltip); null when open or unknown. */
  reason: string | null
}

export function poolSummary(view: LoopRunView): PoolSummary {
  const pool = `Pool ${view.pool.used}/${view.pool.max}`
  const load = view.load
  if (!load) return { text: pool, gateClosed: false, reason: null }
  const gb = (load.memAvailableMb / 1024).toFixed(1)
  return {
    text: `${pool} · load ${load.loadPerCore.toFixed(2)}/core · ${gb} GB free`,
    gateClosed: load.allowsNewLane === false,
    reason: load.reason,
  }
}
