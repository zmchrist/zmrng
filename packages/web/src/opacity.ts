// Surface opacity — a runtime multiplier applied to the frosted-glass panel
// backgrounds (the --surface / --surface-strong / --well / --well-strong
// tokens in theme.css, which are authored as rgba(... calc(<base-alpha> *
// var(--surface-opacity)))) and, inside the native Tauri desktop app, the
// window's own root/body background too. Text, icons, and borders keep their
// own opaque tokens and are untouched. The multiplier is exposed on the
// document root as the --surface-opacity custom property, so lowering it
// makes every glass panel more see-through.
//
// The desktop app's window is already configured native-transparent
// (`transparent: true` in tauri.conf.json), but the webview still paints an
// opaque `body { background: var(--bg) }` over that by default — fading it
// in lockstep with --surface-opacity is what actually lets the real desktop
// show through at low opacity. Gated on isTauriRuntime() (via the
// `data-native-transparent` attribute theme.css reads) so the plain browser
// dev target — which has no native window to show through — keeps its
// existing opaque background regardless of the slider.
//
// Persisted to localStorage only (`zmrng-opacity`), mirroring themes.ts — no
// server involvement, no types.ts change.

import { isTauriRuntime } from './runtime'

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
 * (authored alphas), 0% → 0 (fully see-through glass). Inside the native
 * Tauri desktop app this also flips `data-native-transparent`, which
 * theme.css uses to fade the window's own root/body background — so the
 * whole window, not just the panels, goes see-through toward 0%.
 */
export function applyOpacity(pct: number): void {
  const multiplier = clampOpacity(pct) / 100
  const root = document.documentElement
  root.style.setProperty('--surface-opacity', String(multiplier))
  if (isTauriRuntime()) {
    root.dataset.nativeTransparent = 'true'
  }
}
