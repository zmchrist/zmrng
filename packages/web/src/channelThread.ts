// Pure, React-free reducer for one open channel's message thread. The socket
// delivers only NEW messages live (no history replay), and scrollback comes in
// pages over REST — so this reducer merges both sources into one ascending,
// deduped-by-id list, mirroring the roster.ts / chatThread.ts style. Kept out of
// the React component so it is unit-testable without a DOM.

import type { Message } from './types'

/**
 * Hard cap on retained messages per open channel. Live messaging plus paged
 * scrollback would otherwise grow this list forever while the tab is open — an
 * idle memory leak — so the oldest messages are trimmed past the cap. Scrollback
 * can always re-fetch older pages over REST.
 */
export const MAX_CHANNEL_MESSAGES = 2000

/** The initial (no messages loaded) thread. */
export function emptyThread(): Message[] {
  return []
}

/**
 * Merge messages, dedupe by id (last wins), sort ascending by id, and trim the
 * oldest past `MAX_CHANNEL_MESSAGES` so the thread stays bounded.
 */
function merge(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<number, Message>()
  for (const m of existing) byId.set(m.id, m)
  for (const m of incoming) byId.set(m.id, m)
  const sorted = [...byId.values()].sort((a, b) => a.id - b.id)
  return sorted.length > MAX_CHANNEL_MESSAGES ? sorted.slice(sorted.length - MAX_CHANNEL_MESSAGES) : sorted
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
