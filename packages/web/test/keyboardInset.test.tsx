import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import {
  KEYBOARD_MIN_INSET,
  barOffset,
  keyboardInset,
  useKeyboardInset,
} from '../src/keyboardInset'

describe('keyboardInset', () => {
  it('treats a full-height visual viewport as no keyboard', () => {
    expect(keyboardInset({ innerHeight: 800, viewportHeight: 800, offsetTop: 0 })).toBe(0)
  })

  it('reports the keyboard height when the visual viewport shrinks', () => {
    expect(keyboardInset({ innerHeight: 800, viewportHeight: 500, offsetTop: 0 })).toBe(300)
  })

  it('ignores sub-threshold chrome noise, so a collapsing toolbar is not a keyboard', () => {
    expect(KEYBOARD_MIN_INSET).toBe(80)
    expect(keyboardInset({ innerHeight: 800, viewportHeight: 760, offsetTop: 0 })).toBe(0)
    // Exactly at the threshold counts as a keyboard.
    expect(keyboardInset({ innerHeight: 800, viewportHeight: 720, offsetTop: 0 })).toBe(80)
  })

  it('subtracts offsetTop when iOS scrolls the visual viewport', () => {
    // 300px keyboard, but iOS scrolled the visual viewport 100px down inside
    // the layout viewport — only 200px of the wrap is actually covered.
    expect(keyboardInset({ innerHeight: 800, viewportHeight: 500, offsetTop: 100 })).toBe(200)
  })

  it('returns 0 for missing or non-finite metrics and never goes negative', () => {
    expect(keyboardInset(null)).toBe(0)
    expect(keyboardInset({ innerHeight: NaN, viewportHeight: 500, offsetTop: 0 })).toBe(0)
    expect(keyboardInset({ innerHeight: 800, viewportHeight: Infinity, offsetTop: 0 })).toBe(0)
    expect(keyboardInset({ innerHeight: 800, viewportHeight: 500, offsetTop: NaN })).toBe(0)
    // A visual viewport taller than the layout viewport must not wrap negative.
    expect(keyboardInset({ innerHeight: 500, viewportHeight: 800, offsetTop: 0 })).toBe(0)
  })

  it('never exceeds the layout viewport height', () => {
    expect(keyboardInset({ innerHeight: 400, viewportHeight: 0, offsetTop: 0 })).toBe(400)
  })
})

describe('barOffset', () => {
  it('subtracts the safe-area gap below the bar', () => {
    expect(barOffset(300, 34)).toBe(266)
  })

  it('floors at 0 and stays 0 with the keyboard closed', () => {
    expect(barOffset(300, 400)).toBe(0)
    expect(barOffset(0, 34)).toBe(0)
  })

  it('tolerates a non-finite gap measurement', () => {
    expect(barOffset(300, NaN)).toBe(300)
    expect(barOffset(NaN, 34)).toBe(0)
  })
})

const listeners = new Map<string, Set<() => void>>()

/** Install a controllable `visualViewport` and return a setter for its height. */
function stubVisualViewport(height: number, innerHeight = 800) {
  let h = height
  let offsetTop = 0
  vi.stubGlobal('innerHeight', innerHeight)
  vi.stubGlobal('visualViewport', {
    get height() {
      return h
    },
    get offsetTop() {
      return offsetTop
    },
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)?.add(fn)
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn)
    },
  })
  return (nextHeight: number, nextOffsetTop = 0) => {
    h = nextHeight
    offsetTop = nextOffsetTop
    act(() => {
      for (const fn of listeners.get('resize') ?? []) fn()
    })
  }
}

function Probe() {
  return <span data-testid="inset">{useKeyboardInset()}</span>
}

afterEach(() => {
  listeners.clear()
  vi.unstubAllGlobals()
})

describe('useKeyboardInset', () => {
  it('reports 0 when visualViewport is unavailable', () => {
    vi.stubGlobal('visualViewport', undefined)
    render(<Probe />)
    expect(screen.getByTestId('inset')).toHaveTextContent('0')
  })

  it('re-renders with the new inset when the visual viewport resizes', () => {
    const setHeight = stubVisualViewport(800)
    render(<Probe />)
    expect(screen.getByTestId('inset')).toHaveTextContent('0')

    setHeight(500)
    expect(screen.getByTestId('inset')).toHaveTextContent('300')

    setHeight(800)
    expect(screen.getByTestId('inset')).toHaveTextContent('0')
  })

  it('subscribes to scroll as well as resize, so an iOS viewport scroll is tracked', () => {
    stubVisualViewport(800)
    const { unmount } = render(<Probe />)
    expect(listeners.get('resize')?.size).toBe(1)
    expect(listeners.get('scroll')?.size).toBe(1)

    unmount()
    expect(listeners.get('resize')?.size).toBe(0)
    expect(listeners.get('scroll')?.size).toBe(0)
  })
})
