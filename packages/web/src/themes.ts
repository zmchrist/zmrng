// Theme catalog + pure helpers for computing the accent + bg token overrides
// that theme.css's :root leaves as the default (vermilion on light paper). The
// accent family and --bg are set inline per theme/mode; the rest of the dark
// palette (surfaces, borders, text, status/actor hues) lives in theme.css under
// :root[data-theme='dark'], which applyTheme() toggles.

export type ThemeMode = 'dark' | 'light'

export interface AccentPair {
  /** primary accent hex, e.g. "#edff45" */
  accent: string
  /** secondary accent hex, paired for gradients/duotone */
  accent2: string
  /** gradient end stop; defaults to accent2 when omitted */
  gradTo?: string
}

export interface ThemeDef {
  id: string
  label: string
  /** flat background field color for this theme (light mode) */
  bg: string
  /** flat near-black background field for dark mode; defaults to the shared ink */
  bgDark?: string
  dark: AccentPair
  light: AccentPair
}

export const DEFAULT_THEME_ID = 'vermilion'
export const DARK_BG = '#16130f'
export const DEFAULT_THEME_MODE: ThemeMode = 'light'

// Two themes only: the flat "Vermilion Press" default and its "Cobalt Press"
// A/B swap. The Cosmos glass theme and the per-hue color fields were removed.
//
// Vermilion Press is the app's default look: flat editorial Swiss on light paper
// with a single vermilion "weapon" accent — no gradient, no second hue, so both
// accent stops are the same color (a flat --accent-grad). The flat structure
// (paper surfaces, ink hairlines, hard edges) lives in theme.css :root; these
// entries only push the accent family + bg field.
export const THEMES: ThemeDef[] = [
  {
    id: 'vermilion',
    label: 'Vermilion Press',
    // The default: flat paper field, one vermilion weapon accent. No gradient,
    // no second hue — both stops are the same vermilion so --accent-grad reads
    // as a flat fill. No backdrop → the flat paper base shows through.
    bg: '#f7f5f0',
    bgDark: DARK_BG,
    dark: { accent: '#ff4d1a', accent2: '#ff4d1a' },
    light: { accent: '#ff4d1a', accent2: '#ff4d1a' },
  },
  {
    id: 'cobalt',
    label: 'Cobalt Press',
    // The approved A/B: the same flat Swiss language, weapon swapped to cobalt
    // on cool paper. Single-lever accent change; structure identical.
    bg: '#f5f6fa',
    bgDark: '#12141a',
    // Lightened cobalt: #1a4dff on the dark field is ~2.9:1, under the 4.5:1 text floor.
    dark: { accent: '#6b8cff', accent2: '#6b8cff' },
    light: { accent: '#1a4dff', accent2: '#1a4dff' },
  },
]

export function getTheme(id: string): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME_ID)!
}

/** Parses "#rrggbb" into an "r, g, b" triple usable inside an rgba() string. */
export function hexToRgbTriple(hex: string): string {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `${r}, ${g}, ${b}`
}

export function hexToRgba(hex: string, alpha: number): string {
  return `rgba(${hexToRgbTriple(hex)}, ${alpha})`
}

/** Computes the full set of accent + bg CSS custom properties for a theme/mode pair. */
export function buildThemeVars(theme: ThemeDef, mode: ThemeMode): Record<string, string> {
  const pair = mode === 'dark' ? theme.dark : theme.light
  const gradTo = pair.gradTo ?? pair.accent2
  // Single-hue themes (Vermilion/Cobalt: accent === accent2 with no gradTo)
  // emit a flat solid fill so the "no gradient" Swiss promise holds literally;
  // multi-stop color themes still build a two-stop gradient.
  const accentGrad =
    pair.accent === gradTo ? pair.accent : `linear-gradient(135deg, ${pair.accent} 0%, ${gradTo} 100%)`
  const bg = mode === 'dark' ? (theme.bgDark ?? DARK_BG) : theme.bg
  return {
    '--bg': bg,
    '--accent': pair.accent,
    '--accent-2': pair.accent2,
    '--accent-bright': pair.accent2,
    '--accent-soft': hexToRgba(pair.accent, 0.16),
    '--accent-line': hexToRgba(pair.accent, 0.7),
    '--accent-grad': accentGrad,
    '--accent-ink': bg,
  }
}

const STORAGE_KEY = 'zmrng-theme'

export interface StoredTheme {
  themeId: string
  mode: ThemeMode
}

export function loadStoredTheme(): StoredTheme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { themeId: DEFAULT_THEME_ID, mode: DEFAULT_THEME_MODE }
    const parsed = JSON.parse(raw) as Partial<StoredTheme>
    const themeId = typeof parsed.themeId === 'string' ? parsed.themeId : DEFAULT_THEME_ID
    const mode = parsed.mode === 'light' ? 'light' : 'dark'
    return { themeId, mode }
  } catch {
    return { themeId: DEFAULT_THEME_ID, mode: DEFAULT_THEME_MODE }
  }
}

export function saveStoredTheme(stored: StoredTheme): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // localStorage unavailable (private mode, quota) — theme just won't persist.
  }
}

/** Applies a theme/mode to the document root by setting the computed CSS vars. */
export function applyTheme(themeId: string, mode: ThemeMode): void {
  const theme = getTheme(themeId)
  const vars = buildThemeVars(theme, mode)
  const root = document.documentElement
  root.dataset.theme = mode
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value)
  }
}
