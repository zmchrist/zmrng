// Pure, React-free reducers for the per-card tab strips on the Workspace
// Chat and Terminal cards. Each card owns its own independent tab list (NOT
// a shared dock, unlike the orphaned `terminalDock.ts` this borrows its shape
// from). Ids are supplied by the caller (never Math.random/crypto inside these
// functions) so the module stays pure and deterministic to test.
//
// Terminal tabs auto-spawn their PTY the moment they're added — no extra
// state needed beyond id/label. Chat tabs start `launched: false`: the card
// shows a model/effort/style picker + Launch button, and only mounts the
// `/ws/chat` session once `launchChatTab` flips the flag.

import type {
  CaveStyle,
  ChatTabMeta,
  EffortLevel,
  ModelAlias,
  TerminalTabMeta,
  WorkflowPreset,
} from './types'

/** One terminal tab: just an opaque id + display label. Same shape as the
 *  persisted `TerminalTabMeta` (`types.ts`) — this module IS its reducer. */
export type TerminalTabState = TerminalTabMeta

/** One chat tab: id/label plus the picked config and whether it's been
 *  launched. Same shape as the persisted `ChatTabMeta` (`types.ts`). */
export type ChatTabState = ChatTabMeta

/** An ordered tab list plus the focused tab's id (or null when empty). */
export interface TabsState<T> {
  tabs: T[]
  activeId: string | null
}

/** The default state for either card: no tabs, nothing focused. */
export function emptyTabs<T>(): TabsState<T> {
  return { tabs: [], activeId: null }
}

/** Append a tab and focus it. */
function appendTab<T extends { id: string }>(state: TabsState<T>, tab: T): TabsState<T> {
  return { tabs: [...state.tabs, tab], activeId: tab.id }
}

/**
 * Remove a tab. When the closed tab was active, focus falls to its left
 * neighbor (or the new first tab); when the list empties, `activeId` is null.
 * A no-op if the id is absent.
 */
export function closeTab<T extends { id: string }>(state: TabsState<T>, id: string): TabsState<T> {
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

/** Switch focus to an existing tab. A no-op if the id is absent. */
export function setActiveTab<T extends { id: string }>(state: TabsState<T>, id: string): TabsState<T> {
  if (!state.tabs.some((t) => t.id === id)) return state
  return { ...state, activeId: id }
}

/** A `<Kind> <n>` label, `n` one past the current tab count. */
export function nextLabel(prefix: string, state: TabsState<{ id: string }>): string {
  return `${prefix} ${state.tabs.length + 1}`
}

/** Append a terminal tab (auto-spawns its PTY immediately — no gating) and focus it. */
export function addTerminalTab(
  state: TabsState<TerminalTabState>,
  id: string,
  label: string,
): TabsState<TerminalTabState> {
  return appendTab(state, { id, label })
}

/** Record the server-assigned PTY session id on a terminal tab so a full page
 *  reload can reattach to the same shell. A no-op for an absent id. */
export function setTerminalTabSession(
  state: TabsState<TerminalTabState>,
  id: string,
  sessionId: string,
): TabsState<TerminalTabState> {
  if (!state.tabs.some((t) => t.id === id)) return state
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, sessionId } : t)) }
}

/** Focus the terminal tab attached to the given PTY session (a Lanes terminal
 *  row's id). A no-op when no tab here owns it — e.g. a PTY opened from another
 *  window, or one this tab has not attached to yet. */
export function focusTerminalSession(
  state: TabsState<TerminalTabState>,
  sessionId: string,
): TabsState<TerminalTabState> {
  const tab = state.tabs.find((t) => t.sessionId === sessionId)
  return tab ? setActiveTab(state, tab.id) : state
}

/** Append a chat tab, unlaunched, seeded with the given default config, and focus it. */
export function addChatTab(
  state: TabsState<ChatTabState>,
  id: string,
  label: string,
  defaults: {
    model: ModelAlias
    effort: EffortLevel
    style: CaveStyle
    repoId: string
    workflow: WorkflowPreset
  },
): TabsState<ChatTabState> {
  return appendTab(state, { id, label, ...defaults, launched: false })
}

/** Flip a chat tab's `launched` flag — the card mounts its `ChatPane` once true. */
export function launchChatTab(state: TabsState<ChatTabState>, id: string): TabsState<ChatTabState> {
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, launched: true } : t)) }
}

/** Update a not-yet-launched chat tab's picked model/effort/style/repo/workflow. */
export function setChatTabConfig(
  state: TabsState<ChatTabState>,
  id: string,
  patch: Partial<Pick<ChatTabState, 'model' | 'effort' | 'style' | 'repoId' | 'workflow'>>,
): TabsState<ChatTabState> {
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }
}

/** Record the Lanes row id of a chat tab's live session (sent by the server on
 *  every (re)spawn). A no-op for an absent id. */
export function setChatTabLane(
  state: TabsState<ChatTabState>,
  id: string,
  laneId: string,
): TabsState<ChatTabState> {
  if (!state.tabs.some((t) => t.id === id)) return state
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, laneId } : t)) }
}

/** Focus the chat tab whose live session is the given Lanes row. A no-op when
 *  no tab here owns it (e.g. a session from another window). */
export function focusChatLane(state: TabsState<ChatTabState>, laneId: string): TabsState<ChatTabState> {
  const tab = state.tabs.find((t) => t.laneId === laneId)
  return tab ? setActiveTab(state, tab.id) : state
}

/** Tolerant repair: a persisted `activeId` pointing at a missing tab falls back
 *  to the first tab (or null if the list is empty). */
function repairActiveId<T extends { id: string }>(state: TabsState<T>): TabsState<T> {
  if (state.activeId !== null && !state.tabs.some((t) => t.id === state.activeId)) {
    return { ...state, activeId: state.tabs[0]?.id ?? null }
  }
  return state
}

/** Hydrate the Terminal card's persisted tab list, seeding one default
 *  auto-spawned tab when the doc has none (fresh install / older doc). */
export function hydrateTerminalTabs(stored?: TabsState<TerminalTabState> | null): TabsState<TerminalTabState> {
  if (stored && Array.isArray(stored.tabs) && stored.tabs.length > 0) {
    return repairActiveId({ tabs: stored.tabs, activeId: stored.activeId ?? null })
  }
  return addTerminalTab(emptyTabs(), 'terminal-1', 'Terminal 1')
}

/** Hydrate the Chat card's persisted tab list, seeding one default unlaunched
 *  tab when the doc has none (fresh install / older doc) — the first chat tab
 *  needs a Launch press too, same as every other one.
 *
 *  `seedId` is the id of that fresh default tab. Callers pass a unique id
 *  (e.g. `chat-<uuid>`) so a freshly-seeded default never reuses the
 *  localStorage transcript key of a previously-closed tab — otherwise a new
 *  "Chat 1" would reload the old chat's history. Defaults to `'chat-1'` for
 *  deterministic tests. */
export function hydrateChatTabs(
  stored?: TabsState<ChatTabState> | null,
  seedId = 'chat-1',
): TabsState<ChatTabState> {
  if (stored && Array.isArray(stored.tabs) && stored.tabs.length > 0) {
    return repairActiveId({ tabs: stored.tabs, activeId: stored.activeId ?? null })
  }
  return addChatTab(emptyTabs(), seedId, 'Chat 1', {
    model: 'sonnet',
    effort: 'medium',
    style: 'caveman-full',
    repoId: '',
    workflow: 'none',
  })
}
