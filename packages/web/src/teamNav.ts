// Team-tab navigation state: which rail list is showing, which pane the phone
// shell is on, and the last-opened channel.
//
// The rail used to stack the channels list and the roster list on top of each
// other, which on a phone left the message thread with barely half the screen.
// They are now two tabs — one list at a time — on desktop and phone alike, and
// below the phone breakpoint the rail and the thread become two full-screen
// panes instead of one stacked column.
//
// This module is the pure, DOM-free half: the tab/pane vocabulary, the
// localStorage persistence of the open channel, and the reconciliation of a
// persisted channel id against the channel list the server actually returns.
// It mirrors `mobileTaskPanel.ts` — localStorage only, no server, no DB, no
// types.ts change.

/** The rail's two mutually exclusive lists. */
export type RailTab = 'channels' | 'roster'

/** The phone shell's two full-screen panes: the tabbed rail, or the thread. */
export type TeamPane = 'list' | 'thread'

const STORAGE_KEY = 'zmrng-team-open-channel'

/** The channel id open when the Team tab was last used (null = none). */
export function loadOpenChannelId(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const id = Number(raw)
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

/** Persist the open channel id; `null` clears it (e.g. on leave). */
export function saveOpenChannelId(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, String(id))
  } catch {
    // localStorage unavailable (private mode, quota) — it just won't persist.
  }
}

/**
 * The phone pane to land on at mount: straight into the restored channel's
 * thread when one was persisted, otherwise the channels/roster list.
 */
export function initialPane(openId: number | null): TeamPane {
  return openId === null ? 'list' : 'thread'
}

/**
 * Reconcile the currently-open channel id against the freshly loaded channel
 * list. A still-existing channel (including a persisted one from a previous
 * session) is kept; anything else falls back to the first channel.
 */
export function resolveOpenChannelId(
  current: number | null,
  channels: readonly { id: number }[],
): number | null {
  if (current !== null && channels.some((c) => c.id === current)) return current
  return channels[0]?.id ?? null
}
