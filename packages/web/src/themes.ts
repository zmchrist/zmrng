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
  /**
   * Optional named backdrop this theme paints behind the app (set as the
   * `data-backdrop` attribute on the document root by applyTheme). theme.css
   * gates the cosmic nebula + starfield on `[data-backdrop="cosmos"]`. Themes
   * without a backdrop show a flat `--bg` field.
   */
  backdrop?: string
}

export const DEFAULT_THEME_ID = 'cosmos'
export const DEFAULT_THEME_MODE: ThemeMode = 'dark'

// Order matches the confirmed catalog: one theme per color, plus black/white/grey.
//
// Palette method (per theme): the bold `bg` field keeps its identity hue but is
// tuned for harmony with its accents; each accent pair is chosen in a deliberate
// color-theory relationship to the field (complementary for max pop, analogous
// for a calmer duotone). Dark pairs run brighter/more luminous so they read on
// the dark translucent glass and keep the bg-colored `--accent-ink` legible when
// painted on an accent fill; light pairs are the same hue family pushed lighter.
export const THEMES: ThemeDef[] = [
  {
    id: 'cosmos',
    label: 'Cosmos',
    // The signature look: a deep space-navy field carrying a drifting nebula
    // wash + starfield (painted by the [data-backdrop="cosmos"] layers in
    // theme.css), lit by a warm cosmic gold → amber accent run.
    bg: '#090b13',
    dark: { accent: '#f2ca8a', accent2: '#f0a86a' },
    light: { accent: '#f7d9a0', accent2: '#f5c089' },
    backdrop: 'cosmos',
  },
  {
    id: 'red',
    label: 'Red',
    // Warm-analogous: a clean vivid red field carrying a gold→coral accent run
    // (neighbours on the wheel) for a hot, cohesive duotone.
    bg: '#e01030',
    dark: { accent: '#ffcf4d', accent2: '#ff7a3d' },
    light: { accent: '#ffe08a', accent2: '#ffab7d' },
  },
  {
    id: 'orange',
    label: 'Orange',
    // Complementary: a saturated orange field opposite a chartreuse→gold accent
    // (the signature high-contrast default), gradient hand-tuned to a deep gold.
    bg: '#ff5a1f',
    dark: { accent: '#f2ff4d', accent2: '#ffd23d', gradTo: '#c8e000' },
    light: { accent: '#fff17a', accent2: '#ffdd85' },
  },
  {
    id: 'yellow',
    label: 'Yellow',
    // Complementary: a gold field against a violet→magenta accent, the opposite
    // side of the wheel for a jewel-toned contrast.
    bg: '#f5c518',
    dark: { accent: '#7c5cff', accent2: '#ff4fb8' },
    light: { accent: '#a892ff', accent2: '#ff8fd0' },
  },
  {
    id: 'green',
    label: 'Green',
    // Split-complementary: an emerald field lifted by a gold→coral accent run
    // that warms the cool field without clashing.
    bg: '#12a154',
    dark: { accent: '#ffe066', accent2: '#ff6b6b' },
    light: { accent: '#fff0a3', accent2: '#ff9d9d' },
  },
  {
    id: 'blue',
    label: 'Blue',
    // Complementary: a pure blue field opposite a warm amber→gold accent for a
    // classic blue/orange balance.
    bg: '#0a5cff',
    dark: { accent: '#ff9640', accent2: '#ffd166' },
    light: { accent: '#ffbd85', accent2: '#ffe4a3' },
  },
  {
    id: 'purple',
    label: 'Purple',
    // Complementary duotone: a violet field between a gold accent and a teal
    // second stop, both pulled from the opposite arc of the wheel.
    bg: '#7c2ff5',
    dark: { accent: '#ffd15c', accent2: '#3fe0c4' },
    light: { accent: '#ffe4a0', accent2: '#8ef0e0' },
  },
  {
    id: 'pink',
    label: 'Pink',
    // Complementary: a hot-pink field against a teal→spring-green accent run,
    // cool accents that make the warm field vibrate.
    bg: '#ff2d8f',
    dark: { accent: '#2ff5d6', accent2: '#4dee86' },
    light: { accent: '#8ffbee', accent2: '#a3ffbe' },
  },
  {
    id: 'teal',
    label: 'Teal',
    // Complementary: a teal field opposite a coral→gold accent, warm pops on a
    // cool field.
    bg: '#0fb5a3',
    dark: { accent: '#ff6b6b', accent2: '#ffd24d' },
    light: { accent: '#ffa0a0', accent2: '#ffe694' },
  },
  {
    id: 'black',
    label: 'Black',
    // Neutral field — the accents carry all chroma, so a vivid magenta→cyan
    // duotone spans the wheel for maximum life against near-black.
    bg: '#0a0a0d',
    dark: { accent: '#ff3d81', accent2: '#2ad4ff' },
    light: { accent: '#ff85b3', accent2: '#85e8ff' },
  },
  {
    id: 'white',
    label: 'White',
    // Neutral light field — a blue→coral complementary accent pair gives the
    // pale ground its color, with the bg-ink reading dark on the accents.
    bg: '#f6f6f1',
    dark: { accent: '#2f6bff', accent2: '#ff5a3d' },
    light: { accent: '#7099ff', accent2: '#ff9377' },
  },
  {
    id: 'grey',
    label: 'Grey',
    // Neutral field — a gold→emerald accent pair supplies warm+cool chroma to a
    // desaturated slate ground.
    bg: '#6b7280',
    dark: { accent: '#ffd15c', accent2: '#12d99a' },
    light: { accent: '#ffe4a0', accent2: '#7cf0cd' },
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
  const theme = getTheme(themeId)
  const vars = buildThemeVars(theme, mode)
  const root = document.documentElement
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value)
  }
  // Toggle the backdrop layer (cosmic nebula + starfield) — theme.css gates it
  // on [data-backdrop]. Themes without a backdrop show a flat --bg field.
  if (theme.backdrop) {
    root.setAttribute('data-backdrop', theme.backdrop)
  } else {
    root.removeAttribute('data-backdrop')
  }
}
