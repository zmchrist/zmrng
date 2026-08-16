// Theme catalog + pure helpers for computing the accent-token overrides that
// theme.css's :root leaves as the default (orange/dark). Only the accent
// family of tokens changes per theme/mode — surfaces, borders, and text stay
// on the base tokens defined in theme.css.

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
  /** flat background field color for this theme */
  bg: string
  dark: AccentPair
  light: AccentPair
}

export const DEFAULT_THEME_ID = 'orange'
export const DEFAULT_THEME_MODE: ThemeMode = 'dark'

// Order matches the confirmed catalog: one theme per color, plus black/white/grey.
export const THEMES: ThemeDef[] = [
  {
    id: 'red',
    label: 'Red',
    bg: '#e0102a',
    dark: { accent: '#ffd23f', accent2: '#ff8c42' },
    light: { accent: '#ffe066', accent2: '#ffb347' },
  },
  {
    id: 'orange',
    label: 'Orange',
    bg: '#ff4d00',
    // Exact legacy values — this is the unchanged default look.
    dark: { accent: '#edff45', accent2: '#edff45', gradTo: '#d4e800' },
    light: { accent: '#fff54d', accent2: '#ffcf40' },
  },
  {
    id: 'yellow',
    label: 'Yellow',
    bg: '#f5c400',
    dark: { accent: '#7c3aed', accent2: '#ff2fb0' },
    light: { accent: '#a78bfa', accent2: '#ff6fc9' },
  },
  {
    id: 'green',
    label: 'Green',
    bg: '#0e8f4d',
    dark: { accent: '#ffe66d', accent2: '#ff6b6b' },
    light: { accent: '#fff3a0', accent2: '#ff9b9b' },
  },
  {
    id: 'blue',
    label: 'Blue',
    bg: '#0b5fff',
    dark: { accent: '#ff8a3d', accent2: '#ffd166' },
    light: { accent: '#ffb37a', accent2: '#ffe29c' },
  },
  {
    id: 'purple',
    label: 'Purple',
    bg: '#7b2ff7',
    dark: { accent: '#ffd166', accent2: '#4be3c8' },
    light: { accent: '#ffe29c', accent2: '#8ff0de' },
  },
  {
    id: 'pink',
    label: 'Pink',
    bg: '#ff2d95',
    dark: { accent: '#38f9d7', accent2: '#43e97b' },
    light: { accent: '#8ffbee', accent2: '#9dffb9' },
  },
  {
    id: 'teal',
    label: 'Teal',
    bg: '#0fb8a6',
    dark: { accent: '#ff6b6b', accent2: '#ffd93d' },
    light: { accent: '#ffa3a3', accent2: '#ffe98a' },
  },
  {
    id: 'black',
    label: 'Black',
    bg: '#0a0a0c',
    dark: { accent: '#ff3d81', accent2: '#29e0ff' },
    light: { accent: '#ff7fae', accent2: '#7cecff' },
  },
  {
    id: 'white',
    label: 'White',
    bg: '#f5f5f0',
    dark: { accent: '#2b6cff', accent2: '#ff5b3d' },
    light: { accent: '#6a97ff', accent2: '#ff8f73' },
  },
  {
    id: 'grey',
    label: 'Grey',
    bg: '#6b7280',
    dark: { accent: '#ffd166', accent2: '#06d6a0' },
    light: { accent: '#ffe29c', accent2: '#7bf2cf' },
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
  return {
    '--bg': theme.bg,
    '--accent': pair.accent,
    '--accent-2': pair.accent2,
    '--accent-bright': pair.accent2,
    '--accent-soft': hexToRgba(pair.accent, 0.16),
    '--accent-line': hexToRgba(pair.accent, 0.7),
    '--accent-grad': `linear-gradient(135deg, ${pair.accent} 0%, ${gradTo} 100%)`,
    '--accent-ink': theme.bg,
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
  const vars = buildThemeVars(getTheme(themeId), mode)
  const root = document.documentElement
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value)
  }
}
