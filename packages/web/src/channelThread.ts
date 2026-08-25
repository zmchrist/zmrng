// Pure, React-free reducer for one open channel's message thread. The socket
// delivers only NEW messages live (no history replay), and scrollback comes in
// pages over REST — so this reducer merges both sources into one ascending,
// deduped-by-id list, mirroring the roster.ts / chatThread.ts style. Kept out of
// the React component so it is unit-testable without a DOM.

import type { Message } from './types'

/** The initial (no messages loaded) thread. */
export function emptyThread(): Message[] {
  return []
}

/** Merge messages, dedupe by id (last wins), and sort ascending by id. */
function merge(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<number, Message>()
  for (const m of existing) byId.set(m.id, m)
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

/**
 * Append ONE newly-arrived live message (from the workspace socket) to the
 * thread. Dedupes by id so a re-delivered frame never doubles up, and keeps the
 * list ascending regardless of arrival order.
 */
export function appendMessage(state: Message[], message: Message): Message[] {
  return merge(state, [message])
}

/**
 * Merge a REST scrollback page into the thread. Overlapping ids (a message the
 * socket already delivered) collapse to one entry, so paging back never
 * duplicates a live message. The page is expected oldest-first, but the merge is
 * order-independent.
 */
export function loadScrollback(state: Message[], page: Message[]): Message[] {
  return merge(state, page)
}
