import { describe, it, expect } from 'vitest'
import {
  FLICK_WINDOW_MS,
  LONG_PRESS_SLOP_PX,
  MOMENTUM_FRICTION,
  MOMENTUM_MIN_VELOCITY,
  clampMenuPosition,
  flickVelocity,
  longPressMoved,
  momentumStep,
  pinchDistance,
  pinchScale,
  scrollLinesFor,
} from '../src/terminalTouch'

describe('pinchDistance', () => {
  it('measures the gap between two touches', () => {
    // 3-4-5 triangle.
    expect(pinchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(pinchDistance({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(0)
  })
})

describe('pinchScale', () => {
  it('grows above 1 spreading and shrinks below 1 pinching', () => {
    expect(pinchScale(100, 150)).toBeCloseTo(1.5)
    expect(pinchScale(100, 50)).toBeCloseTo(0.5)
    expect(pinchScale(100, 100)).toBe(1)
  })

  it('guards a zero or non-finite start distance', () => {
    expect(pinchScale(0, 150)).toBe(1)
    expect(pinchScale(NaN, 150)).toBe(1)
    expect(pinchScale(100, NaN)).toBe(1)
  })
})

describe('flickVelocity', () => {
  it('returns signed px/ms over the sample window', () => {
    // 100px up over 100ms.
    expect(flickVelocity([{ y: 200, t: 0 }, { y: 100, t: 100 }])).toBeCloseTo(-1)
    expect(flickVelocity([{ y: 100, t: 0 }, { y: 200, t: 100 }])).toBeCloseTo(1)
  })

  it('ignores samples older than the window, so a pause before release stops it', () => {
    expect(FLICK_WINDOW_MS).toBe(100)
    // A fast swipe long ago, then a stationary finger for the last 100ms.
    const v = flickVelocity([
      { y: 500, t: 0 },
      { y: 100, t: 50 },
      { y: 100, t: 900 },
      { y: 100, t: 1000 },
    ])
    expect(v).toBe(0)
  })

  it('returns 0 for too few samples or a zero time span', () => {
    expect(flickVelocity([])).toBe(0)
    expect(flickVelocity([{ y: 100, t: 0 }])).toBe(0)
    expect(flickVelocity([{ y: 100, t: 50 }, { y: 200, t: 50 }])).toBe(0)
  })
})

describe('momentumStep', () => {
  it('decays the velocity by the exported friction each frame', () => {
    expect(MOMENTUM_FRICTION).toBeCloseTo(0.95)
    const step = momentumStep(1, 16.7)
    expect(step.velocity).toBeCloseTo(0.95, 2)
    expect(step.velocity).toBeLessThan(1)
    expect(step.distance).toBeCloseTo(16.7)
  })

  it('decays monotonically and keeps the sign', () => {
    let v = -2
    let previous = Infinity
    for (let i = 0; i < 10; i++) {
      const step = momentumStep(v, 16.7)
      expect(Math.abs(step.velocity)).toBeLessThanOrEqual(previous)
      if (step.velocity !== 0) expect(step.velocity).toBeLessThan(0)
      previous = Math.abs(step.velocity)
      v = step.velocity
    }
  })

  it('reports a stopped velocity below the threshold, so the rAF loop terminates', () => {
    expect(MOMENTUM_MIN_VELOCITY).toBeCloseTo(0.02)
    expect(momentumStep(MOMENTUM_MIN_VELOCITY / 2, 16.7).velocity).toBe(0)

    let v = 5
    let frames = 0
    while (v !== 0 && frames < 10000) {
      v = momentumStep(v, 16.7).velocity
      frames++
    }
    expect(v).toBe(0)
    expect(frames).toBeLessThan(500)
  })

  it('treats a non-finite velocity as stopped', () => {
    expect(momentumStep(NaN, 16.7).velocity).toBe(0)
    expect(momentumStep(NaN, 16.7).distance).toBe(0)
  })
})

describe('scrollLinesFor', () => {
  it('converts pixels to whole lines and carries the remainder', () => {
    expect(scrollLinesFor(30, 20, 0)).toEqual({ lines: 1, carry: 10 })
    // The carried 10px plus another 30 is two full lines.
    expect(scrollLinesFor(30, 20, 10)).toEqual({ lines: 2, carry: 0 })
  })

  it('lets a slow drag eventually scroll via the carry', () => {
    let carry = 0
    let total = 0
    for (let i = 0; i < 5; i++) {
      const step = scrollLinesFor(5, 20, carry)
      total += step.lines
      carry = step.carry
    }
    expect(total).toBe(1)
  })

  it('keeps the sign when dragging the other way', () => {
    expect(scrollLinesFor(-30, 20, 0)).toEqual({ lines: -1, carry: -10 })
  })

  it('is a no-op for an unmeasurable line height', () => {
    expect(scrollLinesFor(30, 0, 4)).toEqual({ lines: 0, carry: 4 })
    expect(scrollLinesFor(30, NaN, 4)).toEqual({ lines: 0, carry: 4 })
  })
})

describe('longPressMoved', () => {
  it('respects the slop radius', () => {
    expect(LONG_PRESS_SLOP_PX).toBe(10)
    expect(longPressMoved({ x: 100, y: 100 }, { x: 103, y: 104 })).toBe(false)
    expect(longPressMoved({ x: 100, y: 100 }, { x: 120, y: 100 })).toBe(true)
    // Exactly at the slop radius is still a long press.
    expect(longPressMoved({ x: 100, y: 100 }, { x: 110, y: 100 })).toBe(false)
  })

  it('takes an explicit slop', () => {
    expect(longPressMoved({ x: 0, y: 0 }, { x: 30, y: 0 }, 40)).toBe(false)
    expect(longPressMoved({ x: 0, y: 0 }, { x: 30, y: 0 }, 20)).toBe(true)
  })
})

describe('clampMenuPosition', () => {
  const menu = { width: 120, height: 80 }
  const bounds = { width: 400, height: 600 }

  it('leaves a centred press alone', () => {
    expect(clampMenuPosition({ x: 100, y: 200 }, menu, bounds)).toEqual({ left: 100, top: 200 })
  })

  it('keeps the menu inside all four edges', () => {
    expect(clampMenuPosition({ x: -50, y: -50 }, menu, bounds)).toEqual({ left: 8, top: 8 })
    expect(clampMenuPosition({ x: 999, y: 999 }, menu, bounds)).toEqual({
      left: 400 - 120 - 8,
      top: 600 - 80 - 8,
    })
  })

  it('takes an explicit margin', () => {
    expect(clampMenuPosition({ x: 0, y: 0 }, menu, bounds, 20)).toEqual({ left: 20, top: 20 })
  })

  it('falls back to the margin when the menu is bigger than its bounds', () => {
    expect(clampMenuPosition({ x: 10, y: 10 }, menu, { width: 50, height: 40 })).toEqual({
      left: 8,
      top: 8,
    })
  })
})
