import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import styles from './WorkspaceGrid.module.css'
import { GridCard } from './GridCard'
import { CARD_ACCENTS, CARD_TITLES } from '../cardMeta'
import {
  COLS,
  applyMove,
  applyResize,
  cardRectPx,
  cellSize,
  contentHeightPx,
  hideCard,
  toggleMinimize,
  type Cell,
} from '../gridLayout'
import type { GridCardGeo, GridCardId, GridState } from '../types'

/**
 * Cards that own a live socket / long-lived session (a PTY, a `/ws/chat`
 * agent, or a `WorkspaceTabs` pane that may host a ChatPane): they stay MOUNTED
 * even while hidden — the card container is merely `display:none`d — so the
 * session survives a hide→show. Every other card is unmounted while hidden.
 */
const KEEP_MOUNTED: ReadonlySet<GridCardId> = new Set(['terminal', 'chat', 'viewers'])

interface Props {
  grid: GridState
  onGridChange: (next: GridState) => void
  /** Pre-rendered card bodies, keyed by card id (built by WorkspaceView). */
  content: Record<GridCardId, ReactNode>
}

type DragMode = 'move' | 'resize'

interface DragState {
  id: GridCardId
  mode: DragMode
  pointerId: number
  startClientX: number
  startClientY: number
  origin: { x: number; y: number; w: number; h: number }
  dxPx: number
  dyPx: number
}

/** Round a pixel delta into a signed cell-step count for a given step size. */
function stepDelta(px: number, step: number): number {
  return step > 0 ? Math.round(px / step) : 0
}

/** The snapped cell geometry a drag currently targets (clamped into the grid). */
function snappedGeo(drag: DragState, geo: GridCardGeo, cell: Cell) {
  const colStep = cell.colW + cell.gap
  const rowStep = cell.rowH + cell.gap
  if (drag.mode === 'move') {
    const w = drag.origin.w
    const x = Math.max(0, Math.min(COLS - w, drag.origin.x + stepDelta(drag.dxPx, colStep)))
    const y = Math.max(0, drag.origin.y + stepDelta(drag.dyPx, rowStep))
    return { x, y, w, h: drag.origin.h }
  }
  const w = Math.max(geo.minW, Math.min(COLS - drag.origin.x, drag.origin.w + stepDelta(drag.dxPx, colStep)))
  const h = Math.max(geo.minH, drag.origin.h + stepDelta(drag.dyPx, rowStep))
  return { x: drag.origin.x, y: drag.origin.y, w, h }
}

/**
 * The grid host: owns the ResizeObserver (grid width) and the pointer
 * move/resize handlers, calling the pure `gridLayout` reducer to commit every
 * change. Cards are absolutely positioned and translated into place; a height
 * spacer gives the scroll container its extent. This glue is intentionally NOT
 * unit-tested — its correctness rides on the pure reducer beneath it (which is)
 * plus the manual smoke, exactly like the other drag handlers in this repo.
 */
export function WorkspaceGrid({ grid, onGridChange, content }: Props) {
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [gridW, setGridW] = useState(0)
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  useEffect(() => {
    dragRef.current = drag
  }, [drag])

  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (typeof w === 'number') setGridW(w)
    })
    ro.observe(el)
    setGridW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const cell = cellSize(gridW, grid.density)

  const beginDrag = useCallback(
    (mode: DragMode) => (id: GridCardId, geo: GridCardGeo) => (e: ReactPointerEvent<HTMLElement>) => {
      e.preventDefault()
      e.stopPropagation()
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
      setDrag({
        id,
        mode,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        origin: { x: geo.x, y: geo.y, w: geo.w, h: geo.h },
        dxPx: 0,
        dyPx: 0,
      })
    },
    [],
  )

  // Window-level move/up so a fast drag that outruns the handle keeps tracking.
  useEffect(() => {
    if (!drag) return
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d || ev.pointerId !== d.pointerId) return
      setDrag({ ...d, dxPx: ev.clientX - d.startClientX, dyPx: ev.clientY - d.startClientY })
    }
    const onUp = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d || ev.pointerId !== d.pointerId) return
      const geo = grid.cards.find((c) => c.id === d.id)
      if (geo) {
        const snap = snappedGeo(d, geo, cellSize(gridRef.current?.clientWidth ?? gridW, grid.density))
        onGridChange(
          d.mode === 'move'
            ? applyMove(grid, d.id, snap.x, snap.y)
            : applyResize(grid, d.id, snap.w, snap.h),
        )
      }
      setDrag(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [drag, grid, gridW, onGridChange])

  const onMoveDown = beginDrag('move')
  const onResizeDown = beginDrag('resize')

  const spacerHeight = contentHeightPx(grid.cards, cell)
  const dragSnap = drag ? snappedGeo(drag, grid.cards.find((c) => c.id === drag.id)!, cell) : null

  return (
    <div ref={gridRef} className={styles.grid}>
      <div className={styles.spacer} style={{ height: spacerHeight }} />

      {dragSnap && (
        <div
          className={styles.ghost}
          style={{
            transform: `translate(${dragSnap.x * (cell.colW + cell.gap)}px, ${dragSnap.y * (cell.rowH + cell.gap)}px)`,
            width: dragSnap.w * cell.colW + (dragSnap.w - 1) * cell.gap,
            height: dragSnap.h * cell.rowH + (dragSnap.h - 1) * cell.gap,
          }}
        />
      )}

      {grid.cards.map((geo) => {
        if (geo.hidden && !KEEP_MOUNTED.has(geo.id)) return null
        const isDragging = drag?.id === geo.id
        const rect = cardRectPx(geo, cell)
        // While dragging, the active card follows the pointer in raw pixels; the
        // ghost shows the snapped slot it will land in.
        const tx = rect.x + (isDragging ? drag!.dxPx : 0)
        const ty = rect.y + (isDragging ? drag!.dyPx : 0)
        const width = isDragging && drag!.mode === 'resize'
          ? Math.max(cell.colW, rect.width + drag!.dxPx)
          : rect.width
        const positionStyle: CSSProperties = {
          transform: `translate(${tx}px, ${ty}px)`,
          width,
          // A minimized card collapses to its header (auto height); a resizing
          // card follows the pointer; otherwise it uses its cell height.
          height: geo.minimized
            ? undefined
            : isDragging && drag!.mode === 'resize'
              ? Math.max(cell.rowH, rect.height + drag!.dyPx)
              : rect.height,
          ...(geo.hidden ? { display: 'none' } : null),
        }
        return (
          <GridCard
            key={geo.id}
            title={CARD_TITLES[geo.id]}
            styleClassName={`${styles[grid.cardStyle]} ${geo.minimized ? styles.minimized : ''}`}
            positionStyle={{ ...positionStyle, borderLeftColor: CARD_ACCENTS[geo.id] }}
            minimized={!!geo.minimized}
            dragging={isDragging}
            onMovePointerDown={onMoveDown(geo.id, geo)}
            onResizePointerDown={onResizeDown(geo.id, geo)}
            onToggleMinimize={() => onGridChange(toggleMinimize(grid, geo.id))}
            onHide={() => onGridChange(hideCard(grid, geo.id))}
          >
            {content[geo.id]}
          </GridCard>
        )
      })}
    </div>
  )
}
