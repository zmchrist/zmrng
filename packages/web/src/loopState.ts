// Pure, React-free state helpers behind App's Loop wiring: the persisted open
// run, the runs list, the open run's event list, the orchestrator's transient
// partial stream, and the derivation of that transcript into chat bubbles. The
// bubble logic deliberately REUSES the `chatThread.ts` reducer rather than
// growing a second one.

import { emptyThread, finalizeAssistant, pushToolNote, pushUser, type ThreadItem } from './chatThread'
import type { LoopEvent, LoopRun } from './types'

/** localStorage key for the run open in the Loop tab (survives a reload). */
export const LOOP_OPEN_RUN_KEY = 'zmrng-loop-open-run'

/** Read the persisted open run id; null when none (or storage is unavailable). */
export function loadOpenRunId(): string | null {
  try {
    const v = localStorage.getItem(LOOP_OPEN_RUN_KEY)
    return v && v.trim() ? v : null
  } catch {
    return null
  }
}

/** Persist (or, with null, clear) the open run id. Storage failures are ignored. */
export function saveOpenRunId(id: string | null): void {
  try {
    if (id) localStorage.setItem(LOOP_OPEN_RUN_KEY, id)
    else localStorage.removeItem(LOOP_OPEN_RUN_KEY)
  } catch {
    // private mode / quota — the open run just won't survive a reload
  }
}

/** Apply a run update: replace in place, prepend a new run, drop an archived one. */
export function upsertRun(runs: LoopRun[], run: LoopRun): LoopRun[] {
  if (run.status === 'archived') return removeRun(runs, run.id)
  const i = runs.findIndex((r) => r.id === run.id)
  if (i === -1) return [run, ...runs]
  const next = runs.slice()
  next[i] = run
  return next
}

export function removeRun(runs: LoopRun[], id: string): LoopRun[] {
  return runs.filter((r) => r.id !== id)
}

/**
 * Idle-memory cap on the open run's event list: a run streaming for hours would
 * otherwise grow it (and the chat DOM) without bound. Older events stay on the
 * server and are re-fetched (most recent page) when the run is reopened.
 */
export const MAX_LOOP_EVENTS = 1000

function cap(events: LoopEvent[]): LoopEvent[] {
  return events.length > MAX_LOOP_EVENTS ? events.slice(events.length - MAX_LOOP_EVENTS) : events
}

/**
 * Append one streamed event. Event ids are the DB autoincrement, so the list is
 * kept in id order: a duplicate (the fetch and the socket overlapping) is
 * ignored and returns the SAME array, and a late arrival is slotted in.
 */
export function appendLoopEvent(events: LoopEvent[], ev: LoopEvent): LoopEvent[] {
  const last = events.at(-1)
  if (!last || ev.id > last.id) return cap([...events, ev])
  if (events.some((e) => e.id === ev.id)) return events
  return mergeLoopEvents(events, [ev])
}

/** Union two event lists by id, in id order, capped. */
export function mergeLoopEvents(a: LoopEvent[], b: LoopEvent[]): LoopEvent[] {
  const byId = new Map<number, LoopEvent>()
  for (const e of a) byId.set(e.id, e)
  for (const e of b) byId.set(e.id, e)
  return cap([...byId.values()].sort((x, y) => x.id - y.id))
}

/** A finalized orchestrator reply — the moment its streamed partial is superseded. */
export function isOrchestratorReply(ev: LoopEvent): boolean {
  return ev.kind === 'chat' && ev.payload.role === 'orchestrator'
}

/** Same ceiling as the task worker's live text (App's MAX_LIVE_CHARS). */
export const MAX_LOOP_PARTIAL_CHARS = 200_000

/** Accumulate an orchestrator token delta, keeping only the newest tail past the cap. */
export function appendLoopPartial(prev: string, delta: string): string {
  const next = prev + delta
  return next.length > MAX_LOOP_PARTIAL_CHARS ? next.slice(next.length - MAX_LOOP_PARTIAL_CHARS) : next
}

/**
 * The orchestrator transcript as chat items: operator lines are user bubbles,
 * orchestrator replies are closed agent bubbles, and the orchestrator's tool
 * calls, the loop notifications sent to it, and error lines are compact notes.
 * Lane `activity` and `status` lines belong to the lanes/map, not the chat. The
 * live partial is NOT folded in here — callers append it with `appendPartial`
 * so this (the expensive part) can be memoized on the event list alone.
 */
export function loopThread(events: LoopEvent[]): ThreadItem[] {
  let s = emptyThread()
  for (const ev of events) {
    const p = ev.payload
    if (ev.kind === 'error') {
      s = pushToolNote(s, { name: 'error', summary: p.text ?? '', actor: 'loop' })
      continue
    }
    if (ev.kind !== 'chat') continue
    switch (p.role) {
      case 'operator':
        s = pushUser(s, p.text ?? '')
        break
      case 'orchestrator':
        s = finalizeAssistant(s, p.text ?? '')
        break
      case 'tool':
        s = pushToolNote(s, { name: p.tool ?? 'tool', summary: p.summary ?? p.text ?? '', actor: 'main' })
        break
      case 'loop':
        s = pushToolNote(s, { name: 'loop', summary: p.text ?? '', actor: 'loop' })
        break
    }
  }
  return s.items
}
