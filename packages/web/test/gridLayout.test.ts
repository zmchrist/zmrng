import { describe, it, expect } from 'vitest'
import type { GridCardGeo, GridState } from '../src/types'
import {
  COLS,
  applyMove,
  applyResize,
  cardRectPx,
  cellSize,
  collide,
  compact,
  defaultCards,
  hideCard,
  hydrateGrid,
  normalizeGrid,
  showCard,
  toggleMinimize,
} from '../src/gridLayout'

/** Minimal geo helper for the pure collision/compaction tests. */
function geo(id: string, x: number, y: number, w: number, h: number): GridCardGeo {
  return { id: id as GridCardGeo['id'], x, y, w, h, minW: 1, minH: 1 }
}

/** Wrap a card array in a GridState with the given interaction. */
function state(cards: GridCardGeo[], interaction: GridState['interaction'] = 'reflow'): GridState {
  return { cards, density: 'comfortable', cardStyle: 'accent', interaction }
}

/** Look up one card by id in a state. */
function card(s: GridState, id: string): GridCardGeo {
  const c = s.cards.find((k) => k.id === id)
  if (!c) throw new Error(`no card ${id}`)
  return c
}

describe('collide', () => {
  it('detects overlapping rects', () => {
    expect(collide(geo('a', 0, 0, 4, 2), geo('b', 2, 1, 4, 2))).toBe(true)
  })

  it('treats edge-adjacent (touching) rects as NOT colliding', () => {
    // b starts exactly where a ends on x — they touch, not overlap
    expect(collide(geo('a', 0, 0, 4, 2), geo('b', 4, 0, 4, 2))).toBe(false)
    // touching on y
    expect(collide(geo('a', 0, 0, 4, 2), geo('b', 0, 2, 4, 2))).toBe(false)
  })

  it('detects containment', () => {
    expect(collide(geo('a', 0, 0, 6, 6), geo('b', 1, 1, 2, 2))).toBe(true)
  })
})

describe('compact', () => {
  it('packs cards upward with no overlaps', () => {
    const cards = [geo('a', 0, 5, 4, 2), geo('b', 0, 9, 4, 2)]
    const packed = compact(cards)
    expect(card(state(packed), 'a').y).toBe(0)
    // b sits directly under a (a occupies rows 0..2)
    expect(card(state(packed), 'b').y).toBe(2)
  })

  it('keeps a pinned card in its slot while others reflow around it', () => {
    // pin holds the top slot; other (same slot) must reflow below it
    const cards = [geo('pin', 0, 0, 6, 2), geo('other', 0, 0, 6, 2)]
    const packed = compact(cards, 'pin')
    expect(card(state(packed), 'pin').y).toBe(0)
    expect(card(state(packed), 'other').y).toBe(2)
  })

  it('does not mutate the input array', () => {
    const cards = [geo('a', 0, 5, 4, 2)]
    compact(cards)
    expect(cards[0].y).toBe(5)
  })

  it('leaves hidden cards out of the packing (their geometry is preserved)', () => {
    const cards = [geo('vis', 0, 6, 4, 2), { ...geo('hid', 0, 0, 4, 2), hidden: true }]
    const packed = compact(cards)
    // hidden card keeps y=0 and is ignored; visible card packs to y=0 too
    expect(card(state(packed), 'hid').y).toBe(0)
    expect(card(state(packed), 'vis').y).toBe(0)
  })
})

describe('applyMove', () => {
  it('reflow: the dragged card holds its dropped slot; neighbors reflow around it', () => {
    const s = state([geo('a', 0, 0, 6, 2), geo('b', 0, 2, 6, 2)], 'reflow')
    // drop b onto a's slot → b (the dragged card, pinned) keeps (0,0); a bumps below
    const next = applyMove(s, 'b', 0, 0)
    expect(card(next, 'b').y).toBe(0)
    expect(card(next, 'a').y).toBe(2)
  })

  it('swap: exchanges positions with the single collided card', () => {
    const s = state([geo('a', 0, 0, 6, 2), geo('b', 6, 0, 6, 2)], 'swap')
    // move a onto b's slot → they swap (b takes a's old x=0)
    const next = applyMove(s, 'a', 6, 0)
    expect(card(next, 'a').x).toBe(6)
    expect(card(next, 'b').x).toBe(0)
  })

  it('free: leaves the moved card overlapping (no reflow)', () => {
    const s = state([geo('a', 0, 0, 6, 2), geo('b', 0, 2, 6, 2)], 'free')
    const next = applyMove(s, 'b', 0, 0)
    expect(card(next, 'b').y).toBe(0)
    expect(card(next, 'a').y).toBe(0)
  })

  it('clamps the moved card inside the grid (x + w <= COLS, y >= 0)', () => {
    const s = state([geo('a', 0, 0, 6, 2)], 'free')
    const next = applyMove(s, 'a', 20, -5)
    expect(card(next, 'a').x).toBe(COLS - 6)
    expect(card(next, 'a').y).toBe(0)
  })
})

describe('applyResize', () => {
  it('clamps to minW / minH', () => {
    const s = state([{ ...geo('a', 0, 0, 4, 3), minW: 3, minH: 2 }], 'free')
    const next = applyResize(s, 'a', 1, 1)
    expect(card(next, 'a').w).toBe(3)
    expect(card(next, 'a').h).toBe(2)
  })

  it('clamps x + w <= COLS', () => {
    const s = state([{ ...geo('a', 8, 0, 3, 2), minW: 2, minH: 2 }], 'free')
    const next = applyResize(s, 'a', 99, 2)
    expect(card(next, 'a').w).toBe(COLS - 8)
  })

  it('reflow compacts after a resize; free does not', () => {
    const cards = () => [
      { ...geo('a', 0, 0, 6, 2), minW: 2, minH: 2 },
      { ...geo('b', 0, 2, 6, 2), minW: 2, minH: 2 },
    ]
    // grow a downward into b's row → reflow pushes b down
    const reflowed = applyResize(state(cards(), 'reflow'), 'a', 6, 4)
    expect(card(reflowed, 'b').y).toBe(4)
    // free leaves b where it was (now overlapped)
    const free = applyResize(state(cards(), 'free'), 'a', 6, 4)
    expect(card(free, 'b').y).toBe(2)
  })
})

describe('cellSize', () => {
  it('yields distinct rowH / gap per density', () => {
    const comfortable = cellSize(1200, 'comfortable')
    const compactD = cellSize(1200, 'compact')
    const spacious = cellSize(1200, 'spacious')
    expect(new Set([comfortable.rowH, compactD.rowH, spacious.rowH]).size).toBe(3)
    expect(new Set([comfortable.gap, compactD.gap, spacious.gap]).size).toBe(3)
  })

  it('derives colW from gridW and never drops below the floor', () => {
    const wide = cellSize(1200, 'comfortable')
    const narrow = cellSize(120, 'comfortable')
    expect(wide.colW).toBeGreaterThan(narrow.colW)
    // a tiny grid width still floors colW at 22
    expect(cellSize(0, 'comfortable').colW).toBeGreaterThanOrEqual(22)
  })
})

describe('cardRectPx', () => {
  it('converts cell units to pixels using colW/gap/rowH', () => {
    const cell = { colW: 100, gap: 10, rowH: 80 }
    const rect = cardRectPx(geo('a', 1, 2, 2, 3), cell)
    expect(rect.x).toBe(1 * (100 + 10))
    expect(rect.y).toBe(2 * (80 + 10))
    expect(rect.width).toBe(2 * 100 + 1 * 10)
    expect(rect.height).toBe(3 * 80 + 2 * 10)
  })
})

describe('hideCard / showCard / toggleMinimize', () => {
  it('flips the hidden flag without dropping the stored geometry', () => {
    const s = state([geo('files', 3, 4, 2, 5)])
    const hidden = hideCard(s, 'files')
    expect(card(hidden, 'files').hidden).toBe(true)
    // geometry survives the hide → re-showing restores position
    expect(card(hidden, 'files')).toMatchObject({ x: 3, y: 4, w: 2, h: 5 })
    const shown = showCard(hidden, 'files')
    expect(card(shown, 'files').hidden).toBe(false)
    expect(card(shown, 'files')).toMatchObject({ x: 3, y: 4, w: 2, h: 5 })
  })

  it('toggles the minimized flag', () => {
    const s = state([geo('log', 0, 0, 4, 4)])
    expect(card(toggleMinimize(s, 'log'), 'log').minimized).toBe(true)
    expect(card(toggleMinimize(toggleMinimize(s, 'log'), 'log'), 'log').minimized).toBe(false)
  })
})

describe('defaultCards', () => {
  it('seeds all 11 roster cards with no overlaps', () => {
    const cards = defaultCards()
    expect(cards).toHaveLength(11)
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        expect(collide(cards[i], cards[j])).toBe(false)
      }
      // every card fits inside the 12-col grid
      expect(cards[i].x + cards[i].w).toBeLessThanOrEqual(COLS)
      expect(cards[i].w).toBeGreaterThanOrEqual(cards[i].minW)
    }
  })
})

describe('hydrateGrid / normalizeGrid', () => {
  it('seeds defaults when given undefined', () => {
    const s = hydrateGrid(undefined)
    expect(s.cards).toHaveLength(11)
    expect(s.density).toBe('comfortable')
    expect(s.cardStyle).toBe('accent')
    expect(s.interaction).toBe('reflow')
  })

  it('merges a partial persisted state: keeps a stored card, adds a missing roster id, drops an unknown id', () => {
    const stored = {
      cards: [
        { id: 'files', x: 5, y: 6, w: 4, h: 4, minW: 2, minH: 3 },
        { id: 'bogus', x: 0, y: 0, w: 2, h: 2, minW: 1, minH: 1 },
      ],
      density: 'compact',
      cardStyle: 'flat',
      interaction: 'swap',
    } as unknown as GridState
    const s = hydrateGrid(stored)
    // all 11 roster ids present, no unknown id
    expect(s.cards).toHaveLength(11)
    expect(s.cards.some((c) => c.id === 'bogus' as GridCardGeo['id'])).toBe(false)
    expect(s.cards.some((c) => c.id === 'viewers')).toBe(true)
    // the stored files geometry is honored
    expect(card(s, 'files')).toMatchObject({ x: 5, y: 6, w: 4, h: 4 })
    // options round-trip
    expect(s.density).toBe('compact')
    expect(s.cardStyle).toBe('flat')
    expect(s.interaction).toBe('swap')
  })

  it('clamps an out-of-bounds x + w back inside the grid', () => {
    const stored = {
      cards: [{ id: 'pipeline', x: 10, y: 0, w: 8, h: 2, minW: 4, minH: 2 }],
      density: 'comfortable',
      cardStyle: 'accent',
      interaction: 'reflow',
    } as unknown as GridState
    const s = hydrateGrid(stored)
    expect(card(s, 'pipeline').x + card(s, 'pipeline').w).toBeLessThanOrEqual(COLS)
  })

  it('tolerates a malformed / non-array cards value without throwing', () => {
    const s = normalizeGrid({ cards: 'nope', density: 'x', cardStyle: 'y', interaction: 'z' } as unknown as GridState)
    expect(s.cards).toHaveLength(11)
    expect(s.density).toBe('comfortable')
    expect(s.cardStyle).toBe('accent')
    expect(s.interaction).toBe('reflow')
    // wholly undefined input is fine too
    expect(() => normalizeGrid(undefined as unknown as GridState)).not.toThrow()
  })
})
