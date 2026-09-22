/**
 * The arithmetic behind the phone terminal's touch gestures — pinch-to-resize,
 * flick-to-scroll with momentum, and the long-press Paste/Copy menu.
 *
 * DOM-free on purpose: `Terminal.tsx` is the project's documented "untestable
 * glue" (jsdom has no canvas and no live socket), so everything with a right
 * answer lives here where Vitest can drive it, exactly as `terminalProtocol.ts`
 * and `terminalKeys.ts` do.
 */

export interface TouchPoint {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** One position/timestamp sample taken while a finger is dragging. */
export interface FlickSample {
  y: number
  /** Milliseconds, from any monotonic-enough clock (`event.timeStamp`). */
  t: number
}

/** Only samples from the last this-many ms decide the release velocity. */
export const FLICK_WINDOW_MS = 100

/** Per-frame (16.7ms) velocity multiplier — the scroll's exponential friction. */
export const MOMENTUM_FRICTION = 0.95

/** Below this speed (px/ms) the fling is over and the rAF loop stops. */
export const MOMENTUM_MIN_VELOCITY = 0.02

/** A touch may wander this far (px) and still count as a long press. */
export const LONG_PRESS_SLOP_PX = 10

/** Reference frame duration used to normalise the friction to real elapsed time. */
const FRAME_MS = 16.7

/** The distance between two touches — the raw pinch measurement. */
export function pinchDistance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/**
 * How far the pinch has spread relative to where it started. Guards a zero or
 * non-finite start distance (two fingers landing on the same pixel), which
 * would otherwise divide into Infinity and blow the font size out.
 */
export function pinchScale(startDist: number, currentDist: number): number {
  if (!Number.isFinite(startDist) || !Number.isFinite(currentDist) || startDist <= 0) return 1
  return currentDist / startDist
}

/**
 * The signed release velocity in px/ms, measured over the last
 * `FLICK_WINDOW_MS` of samples — so a fast swipe that ends with the finger held
 * still releases at rest rather than flinging.
 */
export function flickVelocity(samples: FlickSample[]): number {
  if (samples.length < 2) return 0
  const last = samples[samples.length - 1]
  const recent = samples.filter((s) => last.t - s.t <= FLICK_WINDOW_MS)
  if (recent.length < 2) return 0
  const first = recent[0]
  const dt = last.t - first.t
  if (dt <= 0) return 0
  return (last.y - first.y) / dt
}

/**
 * Advance a fling by one frame: the distance travelled this frame and the
 * decayed velocity to carry into the next. Returns `velocity: 0` once the speed
 * drops under `MOMENTUM_MIN_VELOCITY`, which is what guarantees the caller's
 * rAF loop terminates.
 */
export function momentumStep(
  velocity: number,
  dtMs: number,
): { velocity: number; distance: number } {
  if (!Number.isFinite(velocity) || !Number.isFinite(dtMs) || velocity === 0) {
    return { velocity: 0, distance: 0 }
  }
  const distance = velocity * dtMs
  const next = velocity * MOMENTUM_FRICTION ** (dtMs / FRAME_MS)
  if (Math.abs(next) < MOMENTUM_MIN_VELOCITY) return { velocity: 0, distance }
  return { velocity: next, distance }
}

/**
 * Turn a pixel delta into whole terminal lines, carrying the sub-line remainder
 * so a slow drag still eventually scrolls instead of rounding away to nothing.
 */
export function scrollLinesFor(
  distancePx: number,
  lineHeightPx: number,
  carry: number,
): { lines: number; carry: number } {
  if (!Number.isFinite(lineHeightPx) || lineHeightPx <= 0 || !Number.isFinite(distancePx)) {
    return { lines: 0, carry }
  }
  const total = distancePx + carry
  const lines = Math.trunc(total / lineHeightPx)
  return { lines, carry: total - lines * lineHeightPx }
}

/** Whether a touch has wandered far enough to cancel a pending long press. */
export function longPressMoved(
  start: TouchPoint,
  current: TouchPoint,
  slopPx: number = LONG_PRESS_SLOP_PX,
): boolean {
  return pinchDistance(start, current) > slopPx
}

/** Position the long-press menu at the press, kept fully inside its bounds. */
export function clampMenuPosition(
  at: TouchPoint,
  menu: Size,
  bounds: Size,
  margin = 8,
): { left: number; top: number } {
  const maxLeft = bounds.width - menu.width - margin
  const maxTop = bounds.height - menu.height - margin
  return {
    left: Math.max(margin, Math.min(at.x, maxLeft)),
    top: Math.max(margin, Math.min(at.y, maxTop)),
  }
}
