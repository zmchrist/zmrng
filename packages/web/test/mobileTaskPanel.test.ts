import { describe, it, expect, beforeEach } from 'vitest'
import {
  beginSwipe,
  KB_PANEL_KEY,
  loadPanelPosition,
  panelState,
  resolveSwipe,
  savePanelPosition,
  stepPanel,
  SWIPE_THRESHOLD_PX,
  TASKS_PANEL_KEY,
} from '../src/mobileTaskPanel'
import type { PanelMove, PanelState } from '../src/mobileTaskPanel'

describe('resolveSwipe', () => {
  it('reads an upward swipe past the threshold as up', () => {
    expect(resolveSwipe(beginSwipe(300), 300 - SWIPE_THRESHOLD_PX)).toBe('up')
  })

  it('reads a downward swipe past the threshold as down', () => {
    expect(resolveSwipe(beginSwipe(300), 300 + SWIPE_THRESHOLD_PX)).toBe('down')
  })

  it('treats movement under the threshold as a tap', () => {
    expect(resolveSwipe(beginSwipe(300), 300)).toBe('tap')
    expect(resolveSwipe(beginSwipe(300), 300 - (SWIPE_THRESHOLD_PX - 1))).toBe('tap')
    expect(resolveSwipe(beginSwipe(300), 300 + (SWIPE_THRESHOLD_PX - 1))).toBe('tap')
  })
})

function run(start: PanelState, moves: PanelMove[]): string[] {
  const out: string[] = []
  let s = start
  for (const m of moves) {
    s = stepPanel(s, m)
    out.push(s.position)
  }
  return out
}

describe('stepPanel', () => {
  it('steps one position per swipe and stops at each end', () => {
    expect(run(panelState('split'), ['up', 'up', 'down', 'down', 'down'])).toEqual([
      'detail',
      'detail',
      'split',
      'list',
      'list',
    ])
  })

  it('cycles list → split → detail → split → list on taps', () => {
    expect(run(panelState('list'), ['tap', 'tap', 'tap', 'tap'])).toEqual([
      'split',
      'detail',
      'split',
      'list',
    ])
  })

  it('heads toward the detail on a tap from a fresh split', () => {
    expect(stepPanel(panelState('split'), 'tap').position).toBe('detail')
  })

  it('keeps tapping away from the end a swipe last left', () => {
    const fromList = stepPanel(panelState('detail'), 'down')
    expect(fromList.position).toBe('split')
    expect(stepPanel(fromList, 'tap').position).toBe('list')
  })
})

describe('panel position persistence', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to split when nothing is stored', () => {
    expect(loadPanelPosition(TASKS_PANEL_KEY)).toBe('split')
    expect(loadPanelPosition(KB_PANEL_KEY)).toBe('split')
  })

  it('round-trips each view under its own key', () => {
    savePanelPosition(TASKS_PANEL_KEY, 'list')
    savePanelPosition(KB_PANEL_KEY, 'detail')
    expect(loadPanelPosition(TASKS_PANEL_KEY)).toBe('list')
    expect(loadPanelPosition(KB_PANEL_KEY)).toBe('detail')
  })

  it('migrates the legacy tasks-collapsed flag', () => {
    localStorage.setItem('zmrng-mobile-tasks-collapsed', 'true')
    expect(loadPanelPosition(TASKS_PANEL_KEY)).toBe('detail')
    expect(loadPanelPosition(KB_PANEL_KEY)).toBe('split')
    localStorage.setItem('zmrng-mobile-tasks-collapsed', 'false')
    expect(loadPanelPosition(TASKS_PANEL_KEY)).toBe('split')
  })

  it('prefers a stored position over the legacy flag and ignores junk', () => {
    localStorage.setItem('zmrng-mobile-tasks-collapsed', 'true')
    savePanelPosition(TASKS_PANEL_KEY, 'list')
    expect(loadPanelPosition(TASKS_PANEL_KEY)).toBe('list')
    localStorage.setItem(KB_PANEL_KEY, 'bogus')
    expect(loadPanelPosition(KB_PANEL_KEY)).toBe('split')
  })
})
