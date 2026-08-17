// Pure, React-free reducer for the bottom-dock tab state (terminal AND chat
// tabs, which coexist in one ordered list). Mirrors the style of
// `workspaceLayout.ts`: every function takes a state and returns a NEW state.
// This state is EPHEMERAL — it is not persisted (PTYs and chat sessions are
// recreated fresh each load), so only the open tabs and which one is focused
// live here. Ids are passed in by the caller (never Math.random/Date.now) so the
// module stays pure and its tests are deterministic.

/** Which kind of bottom-dock tab: a PTY terminal or a standalone agent chat. */
export type DockTabKind = 'terminal' | 'chat'

/** One dock tab. `id` is an opaque, caller-supplied stable key. */
export interface DockTab {
  id: string
  kind: DockTabKind
}

/** The dock's ephemeral tab state: an ordered tab list, the focused id, and
 *  the most recently focused tab id per kind (so a nav-button click can
 *  reopen/refocus the tab the operator was last looking at, per kind). */
export interface DockState {
  tabs: DockTab[]
  activeId: string | null
  lastActiveByKind: Record<DockTabKind, string | null>
}

/** The default dock state: no tabs, nothing focused. */
export function emptyDock(): DockState {
  return { tabs: [], activeId: null, lastActiveByKind: { terminal: null, chat: null } }
}

/** Focus `activeId` (already validated present in `tabs`) and record it as
 *  the last-active tab for its kind. */
function focusTab(state: DockState, tabs: DockTab[], activeId: string): DockState {
  const kind = tabs.find((t) => t.id === activeId)?.kind
  const lastActiveByKind = kind ? { ...state.lastActiveByKind, [kind]: activeId } : state.lastActiveByKind
  return { tabs, activeId, lastActiveByKind }
}

/** Append a tab of the given kind and focus it. */
export function addTab(state: DockState, id: string, kind: DockTabKind): DockState {
  return focusTab(state, [...state.tabs, { id, kind }], id)
}

/** Append a terminal tab and focus it (back-compat shorthand for `addTab`). */
export function addTerminal(state: DockState, id: string): DockState {
  return addTab(state, id, 'terminal')
}

/** Append a chat tab and focus it. */
export function addChat(state: DockState, id: string): DockState {
  return addTab(state, id, 'chat')
}

/**
 * Remove a terminal. When the closed tab was active, focus falls to its left
 * neighbor (or the new first tab); when the dock empties, `activeId` is null.
 * A no-op if the id is absent.
 */
export function closeTerminal(state: DockState, id: string): DockState {
  const idx = state.tabs.findIndex((t) => t.id === id)
  if (idx === -1) return state
  const closedKind = state.tabs[idx].kind
  const tabs = state.tabs.filter((t) => t.id !== id)
  let lastActiveByKind = state.lastActiveByKind
  if (lastActiveByKind[closedKind] === id) {
    lastActiveByKind = { ...lastActiveByKind, [closedKind]: null }
  }
  let activeId = state.activeId
  if (activeId === id) {
    const leftIdx = idx > 0 ? idx - 1 : 0
    activeId = tabs.length > 0 ? tabs[Math.min(leftIdx, tabs.length - 1)].id : null
    if (activeId) {
      const kind = tabs.find((t) => t.id === activeId)?.kind
      if (kind) lastActiveByKind = { ...lastActiveByKind, [kind]: activeId }
    }
  }
  return { tabs, activeId, lastActiveByKind }
}

/** Switch focus to an existing tab. A no-op if the id is absent. */
export function setActive(state: DockState, id: string): DockState {
  if (!state.tabs.some((t) => t.id === id)) return state
  return focusTab(state, state.tabs, id)
}

/**
 * Nav-button focus behavior for a given tab kind: refocus the last-active tab
 * of that kind if one still exists, else fall back to the first tab of that
 * kind, else spawn a fresh one (id supplied by the caller) and focus it.
 * Never destroys or creates a duplicate tab when one is already reachable.
 */
export function focusKind(state: DockState, kind: DockTabKind, spawnId: string): DockState {
  const lastId = state.lastActiveByKind[kind]
  if (lastId && state.tabs.some((t) => t.id === lastId)) {
    return setActive(state, lastId)
  }
  const fallback = state.tabs.find((t) => t.kind === kind)
  if (fallback) return setActive(state, fallback.id)
  return addTab(state, spawnId, kind)
}
