// Pure, React-free reducer + DOM-free geometry for the Workspace dashboard grid.
// Ported faithfully from the mockup's `Component` engine (support.js) and split
// the way this repo splits its other interactive surfaces (`workspaceLayout.ts`,
// `terminalDock.ts`): all the cell-unit array ops and pixel math live here so
// they can be unit-tested without a DOM. The React shell (`WorkspaceGrid.tsx`)
// owns the ResizeObserver + pointer handlers and calls into these functions.
//
// Geometry is stored in CELL units (x,y,w,h ∈ a 12-col space), never pixels, so
// the layout is screen-width-independent and persists cleanly.

import type {
  GridCardGeo,
  GridCardId,
  GridCardStyle,
  GridDensity,
  GridInteraction,
  GridState,
} from './types'

/** The grid is always 12 columns wide. */
export const COLS = 12

/** Every card id in the roster, in seed order. */
export const CARD_IDS: readonly GridCardId[] = [
  'pipeline',
  'concurrency',
  'reviewqueue',
  'newtask',
  'activetask',
  'tasklist',
  'files',
  'viewers',
  'chat',
  'terminal',
]

const DENSITIES: readonly GridDensity[] = ['comfortable', 'compact', 'spacious']
const CARD_STYLES: readonly GridCardStyle[] = ['accent', 'flat', 'outline', 'elevated']
const INTERACTIONS: readonly GridInteraction[] = ['reflow', 'swap', 'free']

/** Row-height + gap per density (px). Ported from the mockup's `dims()`. */
const DENSITY_DIMS: Record<GridDensity, { rowH: number; gap: number }> = {
  comfortable: { rowH: 84, gap: 14 },
  compact: { rowH: 58, gap: 9 },
  spacious: { rowH: 106, gap: 20 },
}

/**
 * The seed layout for the 10-card roster: a sensible non-overlapping arrangement
 * across the 12-column grid. Pure — returns a fresh array each call.
 */
export function defaultCards(): GridCardGeo[] {
  return [
    { id: 'pipeline', x: 0, y: 0, w: 6, h: 2, minW: 4, minH: 2 },
    { id: 'concurrency', x: 6, y: 0, w: 3, h: 2, minW: 3, minH: 2 },
    { id: 'reviewqueue', x: 9, y: 0, w: 3, h: 2, minW: 3, minH: 2 },
    { id: 'files', x: 0, y: 2, w: 3, h: 6, minW: 2, minH: 3 },
    { id: 'viewers', x: 3, y: 2, w: 9, h: 6, minW: 4, minH: 3 },
    { id: 'newtask', x: 0, y: 8, w: 4, h: 3, minW: 3, minH: 2 },
    { id: 'activetask', x: 4, y: 8, w: 4, h: 3, minW: 3, minH: 2 },
    { id: 'tasklist', x: 8, y: 8, w: 4, h: 6, minW: 3, minH: 3 },
    // Terminal + Chat own a PTY / `/ws/chat` session, so they seed HIDDEN — the
    // operator shows them from the Cards menu, matching the old "only spawn on
    // open" behavior. Placed on the bottom row so their absence leaves no hole.
    { id: 'chat', x: 0, y: 11, w: 4, h: 3, minW: 3, minH: 3, hidden: true },
    { id: 'terminal', x: 4, y: 11, w: 4, h: 3, minW: 3, minH: 3, hidden: true },
  ]
}

/** Rect-like used by the collision helpers (a card or a candidate slot). */
interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Do two cell rects overlap? Edge-adjacent (touching) rects do NOT collide. */
export function collide(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/**
 * Pack cards upward (gravity), leaving no overlaps. A `pinnedId` keeps its slot
 * while everything else reflows around it. Hidden cards are ignored (kept at
 * their stored position, never packed and never treated as an obstacle). Pure —
 * the input array is not mutated.
 */
export function compact(cards: GridCardGeo[], pinnedId?: string): GridCardGeo[] {
  const items = cards.map((c) => ({ ...c }))
  const visible = items.filter((c) => !c.hidden)
  const placed: GridCardGeo[] = []
  let pinned: GridCardGeo | undefined
  if (pinnedId) {
    pinned = visible.find((i) => i.id === pinnedId)
    if (pinned) placed.push(pinned)
  }
  const rest = visible
    .filter((i) => i !== pinned)
    .sort((a, b) => a.y - b.y || a.x - b.x)
  for (const it of rest) {
    it.y = 0
    while (placed.some((p) => collide(it, p))) it.y++
    placed.push(it)
  }
  return items
}

/** Coerce to a rounded finite integer, or fall back. */
function coerceInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
}

/** Merge a persisted card's geometry over a default, clamping into the grid.
 *  `minW/minH` always come from the default (the source of truth for mins). */
function mergeGeo(def: GridCardGeo, stored: Partial<GridCardGeo>): GridCardGeo {
  // Width first (bounded to the grid), then pull x back so x + w never exceeds
  // COLS even when the stored x sat far to the right.
  const w = Math.max(def.minW, Math.min(COLS, coerceInt(stored.w, def.w)))
  const x = Math.max(0, Math.min(COLS - w, coerceInt(stored.x, def.x)))
  const y = Math.max(0, coerceInt(stored.y, def.y))
  const h = Math.max(def.minH, coerceInt(stored.h, def.h))
  return {
    id: def.id,
    x,
    y,
    w,
    h,
    minW: def.minW,
    minH: def.minH,
    hidden: !!stored.hidden,
    minimized: !!stored.minimized,
  }
}

/**
 * Repair any (possibly hand-edited / older / malformed) grid state back to the
 * invariants: every roster card present exactly once, unknown ids dropped,
 * geometry clamped into the 12-col grid, and the density/card-style/interaction
 * options validated against their allow-lists. Never throws.
 */
export function normalizeGrid(state: GridState | undefined | null): GridState {
  const rawCards = Array.isArray(state?.cards) ? state!.cards : []
  const byId = new Map<GridCardId, Partial<GridCardGeo>>()
  for (const c of rawCards) {
    if (!c || typeof c.id !== 'string') continue
    if (!CARD_IDS.includes(c.id as GridCardId)) continue
    if (byId.has(c.id as GridCardId)) continue // dedupe — keep the first
    byId.set(c.id as GridCardId, c)
  }
  const cards = defaultCards().map((def) => {
    const stored = byId.get(def.id)
    return stored ? mergeGeo(def, stored) : def
  })
  const density = DENSITIES.includes(state?.density as GridDensity)
    ? (state!.density as GridDensity)
    : 'comfortable'
  const cardStyle = CARD_STYLES.includes(state?.cardStyle as GridCardStyle)
    ? (state!.cardStyle as GridCardStyle)
    : 'accent'
  const interaction = INTERACTIONS.includes(state?.interaction as GridInteraction)
    ? (state!.interaction as GridInteraction)
    : 'reflow'
  return { cards, density, cardStyle, interaction }
}

/** Hydrate a persisted grid state, or seed the default when absent/malformed. */
export function hydrateGrid(stored?: GridState | null): GridState {
  return normalizeGrid(stored ?? undefined)
}

/** Move a card to (x,y), then apply the current interaction mode:
 *  `reflow` compacts, `swap` exchanges with a single collided card, `free`
 *  leaves the overlap. The moved card is always clamped inside the grid. */
export function applyMove(state: GridState, id: string, x: number, y: number): GridState {
  const cards = state.cards.map((c) => ({ ...c }))
  const it = cards.find((c) => c.id === id)
  if (!it) return state
  const prev = { x: it.x, y: it.y }
  it.x = Math.max(0, Math.min(COLS - it.w, Math.round(x)))
  it.y = Math.max(0, Math.round(y))
  if (state.interaction === 'reflow') {
    return { ...state, cards: compact(cards, id) }
  }
  if (state.interaction === 'swap') {
    const c = cards.find((o) => o.id !== id && !o.hidden && collide(it, o))
    if (c) {
      c.x = prev.x
      c.y = prev.y
    }
    return { ...state, cards }
  }
  return { ...state, cards } // free — leave the overlap
}

/** Resize a card to (w,h), clamping to `minW/minH` and `x + w <= COLS`, then
 *  compact under `reflow`/`swap` (both push neighbors), leave it under `free`. */
export function applyResize(state: GridState, id: string, w: number, h: number): GridState {
  const cards = state.cards.map((c) => ({ ...c }))
  const it = cards.find((c) => c.id === id)
  if (!it) return state
  it.w = Math.max(it.minW, Math.min(COLS - it.x, Math.round(w)))
  it.h = Math.max(it.minH, Math.round(h))
  if (state.interaction === 'reflow' || state.interaction === 'swap') {
    return { ...state, cards: compact(cards, id) }
  }
  return { ...state, cards }
}

/** Set a card's `hidden` flag (geometry preserved so re-showing restores it). */
function setHidden(state: GridState, id: string, hidden: boolean): GridState {
  return { ...state, cards: state.cards.map((c) => (c.id === id ? { ...c, hidden } : c)) }
}

/** Hide a card — removed from the grid, its geometry kept for a later re-show. */
export function hideCard(state: GridState, id: string): GridState {
  return setHidden(state, id, true)
}

/** Re-show a hidden card at its stored position. */
export function showCard(state: GridState, id: string): GridState {
  return setHidden(state, id, false)
}

/** Flip a card's `minimized` flag (header-only vs full body). */
export function toggleMinimize(state: GridState, id: string): GridState {
  return {
    ...state,
    cards: state.cards.map((c) => (c.id === id ? { ...c, minimized: !c.minimized } : c)),
  }
}

/** The resolved pixel dimensions of one grid cell at a given width + density. */
export interface Cell {
  colW: number
  gap: number
  rowH: number
}

/** Derive the per-cell pixel size from the grid width and density. `colW` is
 *  floored at 22px so an ultra-narrow grid never collapses to zero-width cells. */
export function cellSize(gridW: number, density: GridDensity): Cell {
  const { rowH, gap } = DENSITY_DIMS[density] ?? DENSITY_DIMS.comfortable
  const w = Number.isFinite(gridW) ? gridW : 0
  const colW = Math.max(22, (w - (COLS - 1) * gap) / COLS)
  return { colW, gap, rowH }
}

/** The pixel rect (top-left + size) of a card at a given cell size. */
export function cardRectPx(item: Rect, cell: Cell): { x: number; y: number; width: number; height: number } {
  const { colW, gap, rowH } = cell
  return {
    x: item.x * (colW + gap),
    y: item.y * (rowH + gap),
    width: item.w * colW + (item.w - 1) * gap,
    height: item.h * rowH + (item.h - 1) * gap,
  }
}

/** Total pixel height of the laid-out (visible) cards — drives the scroll spacer. */
export function contentHeightPx(cards: GridCardGeo[], cell: Cell): number {
  const visible = cards.filter((c) => !c.hidden)
  if (visible.length === 0) return 0
  const maxBottom = Math.max(...visible.map((c) => c.y + c.h))
  return maxBottom * (cell.rowH + cell.gap)
}
