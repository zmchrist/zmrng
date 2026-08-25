// Pure, React-free reducer for the team-workspace presence roster. The server
// sends a full roster snapshot on every join/leave (no history replay), so the
// reducer replaces state on each `roster` frame — but it defensively dedupes by
// id and sorts by display name so rendering is stable regardless of frame order.
// A `pong` frame is presence-neutral and returns the same reference unchanged.

import type { WorkspaceMember, WsWorkspaceServerMsg } from './types'

/** The initial (disconnected / no members) roster. */
export function emptyRoster(): WorkspaceMember[] {
  return []
}

/** Dedupe by id (last wins) and sort by display name, case-insensitive. */
function normalize(members: WorkspaceMember[]): WorkspaceMember[] {
  const byId = new Map<number, WorkspaceMember>()
  for (const m of members) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
  )
}

/**
 * Apply one server frame to the roster state. A `roster` frame replaces the
 * whole roster (full-snapshot semantics); any other frame (`pong`) is
 * presence-neutral and returns the existing state reference untouched.
 */
export function applyWorkspaceMsg(
  state: WorkspaceMember[],
  msg: WsWorkspaceServerMsg,
): WorkspaceMember[] {
  if (msg.type === 'roster') return normalize(msg.members)
  return state
}
