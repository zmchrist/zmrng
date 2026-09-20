// Phone-only collapse gesture for the Tasks / Worker view's task-list panel.
//
// On the phone shell the Tasks view stacks the task list above the worker log.
// A handle bar sits at the panel's bottom edge: swiping UP on it collapses the
// panel (the worker log grows into the freed space), swiping DOWN — or simply
// tapping, which is also the keyboard-accessible path — brings it back. The
// gesture is recognised on the handle only, so scrolling the list or the log is
// never intercepted.
//
// This module is the pure, DOM-free half: gesture resolution plus the
// localStorage persistence of the collapsed flag. It mirrors `opacity.ts` —
// one global setting, no server, no DB, no types.ts change.

/** Vertical travel (px) that makes a touch a directional swipe rather than a tap. */
export const SWIPE_THRESHOLD_PX = 24

const STORAGE_KEY = 'zmrng-mobile-tasks-collapsed'

/** An in-flight handle touch: where the finger went down. */
export interface SwipeGesture {
  startY: number
}

export function beginSwipe(startY: number): SwipeGesture {
  return { startY }
}

/**
 * Resolves a finished handle touch into the next collapsed state.
 *
 * Swipe up past the threshold collapses, swipe down past it expands, and a
 * movement smaller than the threshold is treated as a tap, which toggles.
 * Directional swipes are idempotent: swiping up while already collapsed keeps
 * it collapsed.
 */
export function resolveSwipe(
  gesture: SwipeGesture,
  endY: number,
  collapsed: boolean,
): boolean {
  const dy = endY - gesture.startY
  if (dy <= -SWIPE_THRESHOLD_PX) return true
  if (dy >= SWIPE_THRESHOLD_PX) return false
  return !collapsed
}

export function loadTasksCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveTasksCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(collapsed))
  } catch {
    // localStorage unavailable (private mode, quota) — the state just won't persist.
  }
}
