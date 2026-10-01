import { describe, it, expect, beforeEach } from 'vitest'
import {
  THEMES,
  DEFAULT_THEME_ID,
  DEFAULT_THEME_MODE,
  getTheme,
  hexToRgba,
  buildThemeVars,
  loadStoredTheme,
  saveStoredTheme,
} from '../src/themes'

describe('THEMES catalog', () => {
  it('has exactly two themes: Vermilion Press + Cobalt Press', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['vermilion', 'cobalt'])
    expect(THEMES.map((t) => t.label)).toEqual(['Vermilion Press', 'Cobalt Press'])
  })

  it('vermilion is the default theme, light mode', () => {
    expect(DEFAULT_THEME_ID).toBe('vermilion')
    expect(DEFAULT_THEME_MODE).toBe('light')
  })

  it('every theme defines a dark and light accent pair', () => {
    for (const theme of THEMES) {
      expect(theme.dark.accent).toMatch(/^#[0-9a-f]{6}$/i)
      expect(theme.dark.accent2).toMatch(/^#[0-9a-f]{6}$/i)
      expect(theme.light.accent).toMatch(/^#[0-9a-f]{6}$/i)
      expect(theme.light.accent2).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('every theme has a well-formed bg field and optional gradTo stops', () => {
    for (const theme of THEMES) {
      expect(theme.bg).toMatch(/^#[0-9a-f]{6}$/i)
      if (theme.dark.gradTo !== undefined) expect(theme.dark.gradTo).toMatch(/^#[0-9a-f]{6}$/i)
      if (theme.light.gradTo !== undefined) expect(theme.light.gradTo).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})

describe('getTheme', () => {
  it('finds a theme by id', () => {
    expect(getTheme('cobalt').label).toBe('Cobalt Press')
  })

  it('falls back to the default theme for an unknown id', () => {
    expect(getTheme('nonexistent').id).toBe(DEFAULT_THEME_ID)
  })

  it('falls back to the default for a removed theme a user may still have stored', () => {
    for (const id of ['cosmos', 'orange', 'teal', 'purple']) expect(getTheme(id).id).toBe(DEFAULT_THEME_ID)
  })
})

describe('hexToRgba', () => {
  it('converts a hex color to an rgba() string with the given alpha', () => {
    expect(hexToRgba('#edff45', 0.16)).toBe('rgba(237, 255, 69, 0.16)')
  })
})

describe('buildThemeVars', () => {
  it('wires every accent token from the cobalt pair + bg', () => {
    const vars = buildThemeVars(getTheme('cobalt'), 'light')
    expect(vars['--bg']).toBe('#f5f6fa')
    expect(vars['--accent']).toBe('#1a4dff')
    expect(vars['--accent-2']).toBe('#1a4dff')
    expect(vars['--accent-bright']).toBe('#1a4dff')
    expect(vars['--accent-soft']).toBe('rgba(26, 77, 255, 0.16)')
    expect(vars['--accent-line']).toBe('rgba(26, 77, 255, 0.7)')
    expect(vars['--accent-ink']).toBe('#f5f6fa')
  })

  it('single-hue themes emit a flat accent fill, not a gradient', () => {
    for (const theme of THEMES) {
      for (const mode of ['dark', 'light'] as const) {
        expect(buildThemeVars(theme, mode)['--accent-grad']).toBe(mode === 'dark' ? theme.dark.accent : theme.light.accent)
      }
    }
  })

  it('builds a two-stop gradient when accent and accent2 differ', () => {
    const vars = buildThemeVars({ id: 'x', label: 'X', bg: '#000000', dark: { accent: '#ffcf4d', accent2: '#ff7a3d' }, light: { accent: '#ffcf4d', accent2: '#ff7a3d' } }, 'dark')
    expect(vars['--accent-grad']).toBe('linear-gradient(135deg, #ffcf4d 0%, #ff7a3d 100%)')
  })
})

describe('theme persistence (localStorage)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to the default theme/mode when nothing is stored', () => {
    expect(loadStoredTheme()).toEqual({ themeId: DEFAULT_THEME_ID, mode: DEFAULT_THEME_MODE })
  })

  it('round-trips a saved theme choice', () => {
    saveStoredTheme({ themeId: 'cobalt', mode: 'light' })
    expect(loadStoredTheme()).toEqual({ themeId: 'cobalt', mode: 'light' })
  })

  it('falls back to defaults on corrupt stored JSON', () => {
    localStorage.setItem('zmrng-theme', '{not json')
    expect(loadStoredTheme()).toEqual({ themeId: DEFAULT_THEME_ID, mode: DEFAULT_THEME_MODE })
  })
})
