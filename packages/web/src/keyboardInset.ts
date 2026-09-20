/**
 * How much of the layout viewport the soft keyboard currently covers.
 *
 * iOS Safari does NOT shrink the layout viewport when the keyboard opens — it
 * overlays it. `100dvh` tracks browser chrome, not the keyboard, so a bottom-
 * anchored row (the terminal's on-screen key bar) ends up underneath the
 * keyboard. `visualViewport` is the only signal that sees the keyboard, so this
 * module derives the inset from it and `Terminal.tsx` pads the terminal wrap by
 * that much — which shrinks the xterm host too, so the cursor line stays visible.
 *
 * Android Chrome shrinks the layout viewport itself, so `keyboardInset()`
 * returns 0 there and the plain flex layout already does the right thing.
 *
 * Pure arithmetic + one `useSyncExternalStore` hook, mirroring `useIsMobile.ts`.
 */
import { useSyncExternalStore } from 'react'

/**
 * Below this many pixels the difference is browser chrome (Safari's collapsing
 * toolbar), not a keyboard — real soft keyboards are 200px+ tall.
 */
export const KEYBOARD_MIN_INSET = 80

export interface ViewportMetrics {
  /** The layout viewport height (`window.innerHeight`). */
  innerHeight: number
  /** The visual viewport height (`visualViewport.height`). */
  viewportHeight: number
  /** How far the visual viewport is scrolled inside the layout viewport. */
  offsetTop: number
}

/**
 * The height the keyboard covers, in CSS pixels. Subtracting `offsetTop` is what
 * keeps this correct when iOS scrolls the visual viewport within the layout
 * viewport on focus. Missing or non-finite metrics, and anything under
 * `KEYBOARD_MIN_INSET`, read as "no keyboard".
 */
export function keyboardInset(m: ViewportMetrics | null): number {
  if (!m) return 0
  const { innerHeight, viewportHeight, offsetTop } = m
  if (!Number.isFinite(innerHeight) || !Number.isFinite(viewportHeight)) return 0
  if (!Number.isFinite(offsetTop)) return 0
  const raw = innerHeight - viewportHeight - offsetTop
  const clamped = Math.min(Math.max(raw, 0), innerHeight)
  return clamped < KEYBOARD_MIN_INSET ? 0 : clamped
}

/**
 * How far to lift the key bar. The terminal wrap does not reach the viewport
 * bottom — the phone shell pads it by `env(safe-area-inset-bottom)` — so the
 * padding needed is the keyboard inset minus that gap, or the bar lands
 * `safe-area` px too high.
 */
export function barOffset(inset: number, gapBelowPx: number): number {
  if (!Number.isFinite(inset) || inset <= 0) return 0
  const gap = Number.isFinite(gapBelowPx) ? gapBelowPx : 0
  return Math.max(0, inset - gap)
}

function readMetrics(): ViewportMetrics | null {
  if (typeof window === 'undefined') return null
  const vv = window.visualViewport
  if (!vv) return null
  return { innerHeight: window.innerHeight, viewportHeight: vv.height, offsetTop: vv.offsetTop }
}

function getSnapshot(): number {
  return keyboardInset(readMetrics())
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.visualViewport) return () => {}
  const vv = window.visualViewport
  // `scroll` matters as much as `resize`: iOS scrolls the visual viewport inside
  // the layout viewport on focus without ever resizing it.
  vv.addEventListener('resize', onChange)
  vv.addEventListener('scroll', onChange)
  return () => {
    vv.removeEventListener('resize', onChange)
    vv.removeEventListener('scroll', onChange)
  }
}

/**
 * The current keyboard inset in CSS pixels, 0 when the keyboard is closed or
 * `visualViewport` is unavailable (jsdom, older browsers, desktop). Implemented
 * with `useSyncExternalStore` rather than a state+effect pair, so it never trips
 * `react-hooks/set-state-in-effect` and stays correct across an orientation
 * change.
 */
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => 0)
}
