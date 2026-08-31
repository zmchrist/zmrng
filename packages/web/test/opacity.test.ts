import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_OPACITY,
  MIN_OPACITY,
  MAX_OPACITY,
  clampOpacity,
  loadStoredOpacity,
  saveStoredOpacity,
  applyOpacity,
} from '../src/opacity'

describe('clampOpacity', () => {
  it('keeps in-range whole percentages', () => {
    expect(clampOpacity(0)).toBe(0)
    expect(clampOpacity(55)).toBe(55)
    expect(clampOpacity(100)).toBe(100)
  })

  it('clamps below MIN and above MAX', () => {
    expect(clampOpacity(-20)).toBe(MIN_OPACITY)
    expect(clampOpacity(140)).toBe(MAX_OPACITY)
  })

  it('rounds fractional values', () => {
    expect(clampOpacity(42.4)).toBe(42)
    expect(clampOpacity(42.6)).toBe(43)
  })

  it('falls back to the default for non-finite input', () => {
    expect(clampOpacity(NaN)).toBe(DEFAULT_OPACITY)
    expect(clampOpacity(Infinity)).toBe(MAX_OPACITY)
  })
})

describe('opacity persistence (localStorage)', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to 100 when nothing is stored', () => {
    expect(loadStoredOpacity()).toBe(DEFAULT_OPACITY)
    expect(DEFAULT_OPACITY).toBe(100)
  })

  it('round-trips a saved value', () => {
    saveStoredOpacity(60)
    expect(loadStoredOpacity()).toBe(60)
  })

  it('clamps an out-of-range stored value on load', () => {
    localStorage.setItem('zmrng-opacity', '999')
    expect(loadStoredOpacity()).toBe(MAX_OPACITY)
  })

  it('falls back to the default for a garbage stored value', () => {
    localStorage.setItem('zmrng-opacity', 'not-a-number')
    expect(loadStoredOpacity()).toBe(DEFAULT_OPACITY)
  })

  it('saves the clamped/rounded value, not the raw input', () => {
    saveStoredOpacity(123.7)
    expect(localStorage.getItem('zmrng-opacity')).toBe('100')
    saveStoredOpacity(33.3)
    expect(localStorage.getItem('zmrng-opacity')).toBe('33')
  })
})

describe('applyOpacity', () => {
  it('sets the --surface-opacity multiplier as percent/100', () => {
    applyOpacity(100)
    expect(document.documentElement.style.getPropertyValue('--surface-opacity')).toBe('1')
    applyOpacity(0)
    expect(document.documentElement.style.getPropertyValue('--surface-opacity')).toBe('0')
    applyOpacity(50)
    expect(document.documentElement.style.getPropertyValue('--surface-opacity')).toBe('0.5')
  })

  it('clamps before applying', () => {
    applyOpacity(200)
    expect(document.documentElement.style.getPropertyValue('--surface-opacity')).toBe('1')
  })

  it('does not mark native-transparent in the plain browser (no __TAURI__ global)', () => {
    delete document.documentElement.dataset.nativeTransparent
    applyOpacity(50)
    expect(document.documentElement.dataset.nativeTransparent).toBeUndefined()
  })

  it('marks native-transparent when running inside the Tauri desktop app', () => {
    delete document.documentElement.dataset.nativeTransparent
    ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = {}
    try {
      applyOpacity(50)
      expect(document.documentElement.dataset.nativeTransparent).toBe('true')
    } finally {
      delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
    }
  })
})
