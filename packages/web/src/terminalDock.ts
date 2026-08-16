// Pure, React-free reducer for the bottom-dock terminal tab state. Mirrors the
// style of `workspaceLayout.ts`: every function takes a state and returns a NEW
// state. This state is EPHEMERAL — it is not persisted (PTYs are recreated fresh
// each load), so only the open tabs and which one is focused live here. Ids are
// passed in by the caller (never Math.random/Date.now) so the module stays pure
// and its tests are deterministic.

/** One terminal tab. `id` is an opaque, caller-supplied stable key. */
export interface DockTab {
  id: string
}

/** The dock's ephemeral tab state: an ordered tab list plus the focused id. */
export interface DockState {
  tabs: DockTab[]
  activeId: string | null
}

/** The default dock state: no terminals, nothing focused. */
export function emptyDock(): DockState {
  return { tabs: [], activeId: null }
}

/** Append a terminal with the given id and focus it. */
export function addTerminal(state: DockState, id: string): DockState {
  return { tabs: [...state.tabs, { id }], activeId: id }
}

/**
 * Remove a terminal. When the closed tab was active, focus falls to its left
 * neighbor (or the new first tab); when the dock empties, `activeId` is null.
 * A no-op if the id is absent.
 */
export function closeTerminal(state: DockState, id: string): DockState {
  const idx = state.tabs.findIndex((t) => t.id === id)
  if (idx === -1) return state
  const tabs = state.tabs.filter((t) => t.id !== id)
  let activeId = state.activeId
  if (activeId === id) {
    const leftIdx = idx > 0 ? idx - 1 : 0
    activeId = tabs.length > 0 ? tabs[Math.min(leftIdx, tabs.length - 1)].id : null
  }
  return { tabs, activeId }
}

/** Switch focus to an existing terminal. A no-op if the id is absent. */
export function setActive(state: DockState, id: string): DockState {
  if (!state.tabs.some((t) => t.id === id)) return state
  return { ...state, activeId: id }
}
