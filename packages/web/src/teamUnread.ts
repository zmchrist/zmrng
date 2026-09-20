// Pure, React-free unread tracking for the Team tab's activity-rail orb.
//
// The workspace socket is deliberately gated on the Team tab being active
// (#149) — an idle client on another mode holds ZERO sockets — so live message
// frames are NOT available while the operator is elsewhere. Unread is therefore
// derived from a cheap periodic REST snapshot of each channel's newest message
// (App polls `GET /api/channels` + `?limit=1` while off the Team tab) and fed
// through the reducer below. State is in memory only: it resets on relaunch.
//
// A channel is unread when the newest message id known to exist is greater than
// the newest id the operator has read. The operator's OWN messages never count
// as unread; the agent's replies do.

/** Per-channel high-water marks: what exists vs what has been read. */
export interface UnreadState {
  /** Newest message id known to exist, per channel id. */
  latest: Record<number, number>
  /** Newest message id the operator has read, per channel id. */
  read: Record<number, number>
}

/** A channel's newest message, as observed from a REST snapshot. */
export interface ChannelTip {
  channelId: number
  messageId: number
  /** The message's author handle — used to exclude the operator's own posts. */
  author: string
}

export function emptyUnread(): UnreadState {
  return { latest: {}, read: {} }
}

/**
 * Fold one channel's newest-message observation into the state.
 *
 * The FIRST observation of a channel is a baseline, not an unread signal —
 * otherwise every app start would light the orb for the whole of history. A
 * message authored by `self` is likewise marked read immediately (the operator
 * wrote it; it may reach this client from a second device).
 */
export function observeTip(state: UnreadState, tip: ChannelTip, self: string): UnreadState {
  const { channelId, messageId } = tip
  if (!Number.isInteger(channelId) || !Number.isInteger(messageId)) return state
  const knownLatest = state.latest[channelId]
  const knownRead = state.read[channelId]
  if (knownLatest === messageId && knownRead !== undefined) return state

  const latest = { ...state.latest, [channelId]: Math.max(knownLatest ?? 0, messageId) }
  const isBaseline = knownRead === undefined
  // Own post: only self-reading when nothing was already pending — posting from
  // a second device must not swallow an older unread message in that channel.
  const isMine = self !== '' && tip.author === self && (knownRead ?? 0) >= (knownLatest ?? 0)
  const read =
    isBaseline || isMine
      ? { ...state.read, [channelId]: Math.max(knownRead ?? 0, messageId) }
      : state.read
  return { latest, read }
}

/** Fold a whole snapshot (one tip per channel) in one pass. */
export function observeTips(
  state: UnreadState,
  tips: readonly ChannelTip[],
  self: string,
): UnreadState {
  return tips.reduce((acc, tip) => observeTip(acc, tip, self), state)
}

/**
 * Mark a channel read up to `messageId` — called when the operator opens that
 * channel (and for each live message that lands while they are watching it).
 * Clearing is per channel by design: merely switching to the Team tab does not
 * clear anything.
 */
export function markRead(state: UnreadState, channelId: number, messageId: number): UnreadState {
  if (!Number.isInteger(channelId) || !Number.isInteger(messageId)) return state
  const knownRead = state.read[channelId] ?? 0
  if (messageId <= knownRead) return state
  return {
    latest: { ...state.latest, [channelId]: Math.max(state.latest[channelId] ?? 0, messageId) },
    read: { ...state.read, [channelId]: messageId },
  }
}

/** True when ANY channel has a message newer than what has been read. */
export function hasUnread(state: UnreadState): boolean {
  return Object.keys(state.latest).some(
    (id) => state.latest[Number(id)] > (state.read[Number(id)] ?? 0),
  )
}
