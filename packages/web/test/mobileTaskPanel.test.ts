import { describe, it, expect, beforeEach } from 'vitest'
import {
  beginSwipe,
  loadTasksCollapsed,
  resolveSwipe,
  saveTasksCollapsed,
  SWIPE_THRESHOLD_PX,
} from '../src/mobileTaskPanel'

describe('resolveSwipe', () => {
  it('collapses on a swipe up past the threshold', () => {
    const g = beginSwipe(300)
    expect(resolveSwipe(g, 300 - SWIPE_THRESHOLD_PX, false)).toBe(true)
  })

  it('expands on a swipe down past the threshold', () => {
    const g = beginSwipe(300)
    expect(resolveSwipe(g, 300 + SWIPE_THRESHOLD_PX, true)).toBe(false)
  })

  it('is idempotent for a swipe in the direction already applied', () => {
    expect(resolveSwipe(beginSwipe(300), 200, true)).toBe(true)
    expect(resolveSwipe(beginSwipe(300), 400, false)).toBe(false)
  })

  it('treats a movement under the threshold as a tap and toggles', () => {
    expect(resolveSwipe(beginSwipe(300), 300, false)).toBe(true)
    expect(resolveSwipe(beginSwipe(300), 300, true)).toBe(false)
    expect(resolveSwipe(beginSwipe(300), 300 - (SWIPE_THRESHOLD_PX - 1), false)).toBe(true)
    expect(resolveSwipe(beginSwipe(300), 300 + (SWIPE_THRESHOLD_PX - 1), true)).toBe(false)
  })
})

describe('collapsed-state persistence', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to expanded when nothing is stored', () => {
    expect(loadTasksCollapsed()).toBe(false)
  })

  it('round-trips through localStorage', () => {
    saveTasksCollapsed(true)
    expect(loadTasksCollapsed()).toBe(true)
    saveTasksCollapsed(false)
    expect(loadTasksCollapsed()).toBe(false)
  })
})
