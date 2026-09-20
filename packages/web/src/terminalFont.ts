/**
 * Terminal font size — the value a pinch on the phone terminal changes.
 *
 * Modelled on `opacity.ts` (clamp → persist → apply) but with a tiny
 * subscribe/notify store on top: terminal tabs stay mounted when inactive, so a
 * pinch in one tab must reach every other mounted terminal live. A
 * remount-only approach would leave the others stale.
 *
 * Persisted to localStorage only (`zmrng-term-font`) — no server involvement,
 * no types.ts change.
 */

/** The single source of truth for the terminal's default font size. */
export const DEFAULT_TERMINAL_FONT_SIZE = 13
export const MIN_TERMINAL_FONT_SIZE = 9
export const MAX_TERMINAL_FONT_SIZE = 24

const STORAGE_KEY = 'zmrng-term-font'

/** Clamps a size into the [MIN, MAX] range and rounds to a whole pixel. */
export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_TERMINAL_FONT_SIZE
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(px)))
}

/** The size a pinch of `scale` produces from the size the gesture started at. */
export function pinchFontSize(base: number, scale: number): number {
  return clampFontSize(base * scale)
}

function loadStored(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_TERMINAL_FONT_SIZE
    const n = Number(raw)
    if (!Number.isFinite(n)) return DEFAULT_TERMINAL_FONT_SIZE
    return clampFontSize(n)
  } catch {
    return DEFAULT_TERMINAL_FONT_SIZE
  }
}

let current: number | null = null
const listeners = new Set<() => void>()

/** The live font size, hydrated from localStorage on first read then cached. */
export function getFontSize(): number {
  if (current === null) current = loadStored()
  return current
}

/** Clamp, persist, and notify every mounted terminal. A no-op when unchanged. */
export function setFontSize(px: number): void {
  const next = clampFontSize(px)
  if (next === getFontSize()) return
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, String(next))
  } catch {
    // localStorage unavailable (private mode, quota) — the size just won't persist.
  }
  for (const fn of listeners) fn()
}

/** Subscribe to font-size changes; returns the unsubscribe function. */
export function subscribeFontSize(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
