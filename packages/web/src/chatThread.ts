// Pure, React-free reducer for the standalone chat's bubble-thread state, so the
// messaging logic is unit-testable without a DOM (the `ChatPane` component
// itself, like `Terminal`, stays untested — jsdom has no WebSocket glue worth
// exercising). Every function takes a state and returns a NEW state; nothing
// mutates its input.

/** One item in the thread: a user bubble, an agent bubble, or a slim tool note. */
export type ThreadItem =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; text: string; streaming: boolean }
  | { kind: 'tool'; name: string; summary: string; actor: string }

/** The thread: an ordered item list plus a `busy` flag (a turn is in flight). */
export interface ThreadState {
  items: ThreadItem[]
  busy: boolean
}

/**
 * Hard cap on how many items one thread retains in memory. A long-lived chat
 * would otherwise grow the item list (and its DOM) without bound, a real idle
 * memory leak — so the oldest items are dropped once the cap is exceeded.
 */
export const MAX_THREAD_ITEMS = 1000

/** Drop the oldest items so the list never exceeds `MAX_THREAD_ITEMS`. */
function capItems(items: ThreadItem[]): ThreadItem[] {
  return items.length > MAX_THREAD_ITEMS ? items.slice(items.length - MAX_THREAD_ITEMS) : items
}

/** The default thread: empty, idle. */
export function emptyThread(): ThreadState {
  return { items: [], busy: false }
}

/** Append an operator bubble and mark the thread busy (a turn has begun). */
export function pushUser(state: ThreadState, text: string): ThreadState {
  return { items: capItems([...state.items, { kind: 'user', text }]), busy: true }
}

/** True when the last item is an open (streaming) agent bubble. */
function lastIsStreaming(items: ThreadItem[]): boolean {
  const last = items.at(-1)
  return last?.kind === 'agent' && last.streaming
}

/**
 * Append a streamed token delta. Opens a streaming agent bubble when none is
 * open, otherwise extends the current one.
 */
export function appendPartial(state: ThreadState, delta: string): ThreadState {
  if (lastIsStreaming(state.items)) {
    const items = state.items.slice()
    const last = items[items.length - 1] as Extract<ThreadItem, { kind: 'agent' }>
    items[items.length - 1] = { ...last, text: last.text + delta }
    return { ...state, items }
  }
  return { ...state, items: capItems([...state.items, { kind: 'agent', text: delta, streaming: true }]) }
}

/**
 * Close the turn's agent bubble to final text. Replaces the open streaming
 * bubble when one exists; otherwise pushes a fresh closed bubble.
 */
export function finalizeAssistant(state: ThreadState, text: string): ThreadState {
  if (lastIsStreaming(state.items)) {
    const items = state.items.slice()
    items[items.length - 1] = { kind: 'agent', text, streaming: false }
    return { ...state, items }
  }
  return { ...state, items: capItems([...state.items, { kind: 'agent', text, streaming: false }]) }
}

/** Insert a slim tool-use note row. */
export function pushToolNote(
  state: ThreadState,
  note: { name: string; summary: string; actor: string },
): ThreadState {
  return {
    ...state,
    items: capItems([...state.items, { kind: 'tool', name: note.name, summary: note.summary, actor: note.actor }]),
  }
}

/** End the turn: clear `busy` and close any still-open streaming bubble. */
export function endTurn(state: ThreadState): ThreadState {
  if (lastIsStreaming(state.items)) {
    const items = state.items.slice()
    const last = items[items.length - 1] as Extract<ThreadItem, { kind: 'agent' }>
    items[items.length - 1] = { ...last, streaming: false }
    return { items, busy: false }
  }
  return { ...state, busy: false }
}

/** Discard the whole thread (a config change respawns the session). */
export function resetThread(): ThreadState {
  return emptyThread()
}

/**
 * True when a turn is in flight but the agent has not opened its reply bubble
 * yet — i.e. the operator has sent and is waiting for the first token. Drives
 * the "thinking" dots indicator, which vanishes the moment an agent bubble
 * (streaming or finalized) appears.
 */
export function isAwaitingReply(state: ThreadState): boolean {
  return state.busy && state.items.at(-1)?.kind !== 'agent'
}
