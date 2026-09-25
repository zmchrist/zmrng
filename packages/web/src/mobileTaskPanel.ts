// Phone-only three-position split for a stacked list/detail view.
//
// On the phone shell the Tasks / Worker view stacks the task list above the
// worker log, and the KB view stacks its Spaces/Pages sidebar above the open
// page. A handle bar between the two steps the split through three positions:
//
//   'list'   — the list fills the screen, the detail is hidden
//   'split'  — half and half (the default)
//   'detail' — the detail fills the screen, the list is hidden
//
// Swiping UP on the handle moves one step toward the detail, swiping DOWN one
// step toward the list; both stop at the ends. A tap — also the keyboard path —
// cycles list → split → detail → split → list. The gesture is recognised on the
// handle only, so scrolling either half is never intercepted.
//
// This module is the pure, DOM-free half: gesture resolution, the step
// function, and per-view localStorage persistence. It mirrors `opacity.ts` —
// no server, no DB, no types.ts change.

/** Vertical travel (px) that makes a touch a directional swipe rather than a tap. */
export const SWIPE_THRESHOLD_PX = 24

export type PanelPosition = 'list' | 'split' | 'detail'

/** The split's position plus where a tap from 'split' goes next. */
export interface PanelState {
  position: PanelPosition
  heading: 'list' | 'detail'
}

export type PanelMove = 'up' | 'down' | 'tap'

/** An in-flight handle touch: where the finger went down. */
export interface SwipeGesture {
  startY: number
}

export function beginSwipe(startY: number): SwipeGesture {
  return { startY }
}

/**
 * Resolves a finished handle touch into a move. Travel past the threshold is a
 * directional swipe; anything smaller is a tap.
 */
export function resolveSwipe(gesture: SwipeGesture, endY: number): PanelMove {
  const dy = endY - gesture.startY
  if (dy <= -SWIPE_THRESHOLD_PX) return 'up'
  if (dy >= SWIPE_THRESHOLD_PX) return 'down'
  return 'tap'
}

/** A state resting at `position`; a tap from 'split' heads toward the detail first. */
export function panelState(position: PanelPosition, heading: PanelState['heading'] = 'detail'): PanelState {
  if (position === 'list') return { position, heading: 'detail' }
  if (position === 'detail') return { position, heading: 'list' }
  return { position, heading }
}

/** Applies one move to the split. Swipes clamp at the ends; a tap bounces between them. */
export function stepPanel(state: PanelState, move: PanelMove): PanelState {
  const { position } = state
  if (move === 'up') {
    return position === 'list' ? panelState('split', 'detail') : panelState('detail')
  }
  if (move === 'down') {
    return position === 'detail' ? panelState('split', 'list') : panelState('list')
  }
  if (position === 'list') return panelState('split', 'detail')
  if (position === 'detail') return panelState('split', 'list')
  return panelState(state.heading)
}

export const TASKS_PANEL_KEY = 'zmrng-mobile-tasks-panel'
export const KB_PANEL_KEY = 'zmrng-mobile-kb-panel'
/** The pre-three-position boolean flag for the Tasks view: `true` meant list hidden. */
const LEGACY_TASKS_COLLAPSED_KEY = 'zmrng-mobile-tasks-collapsed'

function isPosition(v: string | null): v is PanelPosition {
  return v === 'list' || v === 'split' || v === 'detail'
}

/**
 * Reads a view's saved position, defaulting to 'split'. For the Tasks view the
 * legacy collapsed flag is honoured when no new value is stored yet.
 */
export function loadPanelPosition(key: string): PanelPosition {
  try {
    const stored = localStorage.getItem(key)
    if (isPosition(stored)) return stored
    if (key === TASKS_PANEL_KEY && localStorage.getItem(LEGACY_TASKS_COLLAPSED_KEY) === 'true') {
      return 'detail'
    }
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  return 'split'
}

export function savePanelPosition(key: string, position: PanelPosition): void {
  try {
    localStorage.setItem(key, position)
  } catch {
    // localStorage unavailable (private mode, quota) — the state just won't persist.
  }
}
