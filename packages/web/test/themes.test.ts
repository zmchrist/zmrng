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
  it('has 11 themes: one per color plus black/white/grey', () => {
    expect(THEMES).toHaveLength(11)
    const ids = THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(11)
    for (const id of ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'teal', 'black', 'white', 'grey']) {
      expect(ids).toContain(id)
    }
  })

  it('every theme defines a dark and light accent pair', () => {
    for (const theme of THEMES) {
      expect(theme.dark.accent).toMatch(/^#[0-9a-f]{6}$/i)
      expect(theme.dark.accent2).toMatch(/^#[0-9a-f]{6}$/i)
      expect(theme.light.accent).toMatch(/^#[0-9a-f]{6}$/i)
      expect(theme.light.accent2).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})

describe('getTheme', () => {
  it('finds a theme by id', () => {
    expect(getTheme('teal').label).toBe('Teal')
  })

  it('falls back to the default theme for an unknown id', () => {
    expect(getTheme('nonexistent').id).toBe(DEFAULT_THEME_ID)
  })
})

describe('hexToRgba', () => {
  it('converts a hex color to an rgba() string with the given alpha', () => {
    expect(hexToRgba('#edff45', 0.16)).toBe('rgba(237, 255, 69, 0.16)')
  })
})

describe('buildThemeVars', () => {
  it('reproduces the exact legacy tokens for orange/dark (unchanged default)', () => {
    const vars = buildThemeVars(getTheme('orange'), 'dark')
    expect(vars['--bg']).toBe('#ff4d00')
    expect(vars['--accent']).toBe('#edff45')
    expect(vars['--accent-2']).toBe('#edff45')
    expect(vars['--accent-bright']).toBe('#edff45')
    expect(vars['--accent-soft']).toBe('rgba(237, 255, 69, 0.16)')
    expect(vars['--accent-line']).toBe('rgba(237, 255, 69, 0.7)')
    expect(vars['--accent-grad']).toBe('linear-gradient(135deg, #edff45 0%, #d4e800 100%)')
    expect(vars['--accent-ink']).toBe('#ff4d00')
  })

  it('swaps to the brighter accent pair for light mode', () => {
    const dark = buildThemeVars(getTheme('teal'), 'dark')
    const light = buildThemeVars(getTheme('teal'), 'light')
    expect(light['--accent']).not.toBe(dark['--accent'])
    expect(light['--bg']).toBe(dark['--bg']) // bg does not change with mode
  })

  it('builds a two-stop gradient from accent to accent2 when no gradTo is set', () => {
    const vars = buildThemeVars(getTheme('red'), 'dark')
    expect(vars['--accent-grad']).toBe('linear-gradient(135deg, #ffd23f 0%, #ff8c42 100%)')
  })
})

describe('theme persistence (localStorage)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to orange/dark when nothing is stored', () => {
    expect(loadStoredTheme()).toEqual({ themeId: DEFAULT_THEME_ID, mode: DEFAULT_THEME_MODE })
  })

  it('round-trips a saved theme choice', () => {
    saveStoredTheme({ themeId: 'purple', mode: 'light' })
    expect(loadStoredTheme()).toEqual({ themeId: 'purple', mode: 'light' })
  })

  it('falls back to defaults on corrupt stored JSON', () => {
    localStorage.setItem('zmrng-theme', '{not json')
    expect(loadStoredTheme()).toEqual({ themeId: DEFAULT_THEME_ID, mode: DEFAULT_THEME_MODE })
  })
})
