import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const STORAGE_KEY = 'zmrng-term-font'

/**
 * The store caches its value after the first read, so every test loads a fresh
 * module instance — that is what lets the hydrate-from-localStorage cases run.
 */
async function loadModule() {
  vi.resetModules()
  return import('../src/terminalFont')
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('clampFontSize', () => {
  it('holds the 9–24 bounds and rounds to a whole pixel', async () => {
    const { clampFontSize, MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE } = await loadModule()
    expect(MIN_TERMINAL_FONT_SIZE).toBe(9)
    expect(MAX_TERMINAL_FONT_SIZE).toBe(24)
    expect(clampFontSize(13)).toBe(13)
    expect(clampFontSize(2)).toBe(9)
    expect(clampFontSize(99)).toBe(24)
    expect(clampFontSize(13.6)).toBe(14)
    expect(clampFontSize(13.2)).toBe(13)
  })

  it('falls back to the default for non-finite input', async () => {
    const { clampFontSize, DEFAULT_TERMINAL_FONT_SIZE } = await loadModule()
    expect(DEFAULT_TERMINAL_FONT_SIZE).toBe(13)
    expect(clampFontSize(NaN)).toBe(13)
    expect(clampFontSize(Infinity)).toBe(13)
  })
})

describe('pinchFontSize', () => {
  it('scales up and down from the gesture-start base', async () => {
    const { pinchFontSize } = await loadModule()
    expect(pinchFontSize(13, 1)).toBe(13)
    expect(pinchFontSize(12, 1.5)).toBe(18)
    expect(pinchFontSize(20, 0.5)).toBe(10)
  })

  it('clamps at both ends', async () => {
    const { pinchFontSize } = await loadModule()
    expect(pinchFontSize(20, 4)).toBe(24)
    expect(pinchFontSize(10, 0.2)).toBe(9)
  })
})

describe('the font-size store', () => {
  it('round-trips through localStorage', async () => {
    const { getFontSize, setFontSize } = await loadModule()
    setFontSize(18)
    expect(getFontSize()).toBe(18)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('18')

    // A fresh module instance (a reload) hydrates the stored value.
    const reloaded = await loadModule()
    expect(reloaded.getFontSize()).toBe(18)
  })

  it('clamps what it persists', async () => {
    const { getFontSize, setFontSize } = await loadModule()
    setFontSize(400)
    expect(getFontSize()).toBe(24)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('24')
  })

  it('yields the default for an absent or corrupt stored value', async () => {
    const absent = await loadModule()
    expect(absent.getFontSize()).toBe(13)

    localStorage.setItem(STORAGE_KEY, 'not-a-number')
    const corrupt = await loadModule()
    expect(corrupt.getFontSize()).toBe(13)
  })

  it('does not throw when localStorage is disabled', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    const { getFontSize, setFontSize } = await loadModule()
    expect(getFontSize()).toBe(13)
    expect(() => setFontSize(20)).not.toThrow()
    // Still live in memory for this session, just not persisted.
    expect(getFontSize()).toBe(20)
  })
})

describe('subscribeFontSize', () => {
  it('notifies every listener on a change — this is what reaches the other tabs', async () => {
    const { setFontSize, subscribeFontSize } = await loadModule()
    const a = vi.fn()
    const b = vi.fn()
    subscribeFontSize(a)
    subscribeFontSize(b)

    setFontSize(20)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('stops notifying after unsubscribe', async () => {
    const { setFontSize, subscribeFontSize } = await loadModule()
    const fn = vi.fn()
    const unsubscribe = subscribeFontSize(fn)

    setFontSize(20)
    expect(fn).toHaveBeenCalledTimes(1)

    unsubscribe()
    setFontSize(14)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the clamped value does not actually change', async () => {
    const { setFontSize, subscribeFontSize } = await loadModule()
    const fn = vi.fn()
    subscribeFontSize(fn)

    setFontSize(13) // already the default
    expect(fn).not.toHaveBeenCalled()

    setFontSize(24)
    expect(fn).toHaveBeenCalledTimes(1)
    setFontSize(99) // clamps back to 24 — no change
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
