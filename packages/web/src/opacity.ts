// Surface opacity — a runtime multiplier applied to the frosted-glass panel
// backgrounds only (the --surface / --surface-strong / --well / --well-strong
// tokens in theme.css, which are authored as rgba(... calc(<base-alpha> *
// var(--surface-opacity)))). Text, icons, and borders keep their own opaque
// tokens and are untouched. The multiplier is exposed on the document root as
// the --surface-opacity custom property, so lowering it makes every glass panel
// more see-through (the desktop/wallpaper shows through) while everything drawn
// on top stays fully legible.
//
// Persisted to localStorage only (`zmrng-opacity`), mirroring themes.ts — no
// server involvement, no types.ts change.

/** 0 = fully see-through glass, 100 = today's authored alphas untouched. */
export const DEFAULT_OPACITY = 100
export const MIN_OPACITY = 0
export const MAX_OPACITY = 100

const STORAGE_KEY = 'zmrng-opacity'

/** Clamps a percentage into the [MIN, MAX] range and rounds to a whole number. */
export function clampOpacity(pct: number): number {
  if (!Number.isFinite(pct)) return DEFAULT_OPACITY
  return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, Math.round(pct)))
}

export function loadStoredOpacity(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_OPACITY
    return clampOpacity(Number(raw))
  } catch {
    return DEFAULT_OPACITY
  }
}

export function saveStoredOpacity(pct: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(clampOpacity(pct)))
  } catch {
    // localStorage unavailable (private mode, quota) — opacity just won't persist.
  }
}

/**
 * Applies a surface-opacity percentage to the document root by setting the
 * --surface-opacity multiplier the surface tokens compose into. 100% → 1
 * (authored alphas), 0% → 0 (fully see-through glass).
 */
export function applyOpacity(pct: number): void {
  const multiplier = clampOpacity(pct) / 100
  document.documentElement.style.setProperty('--surface-opacity', String(multiplier))
}
