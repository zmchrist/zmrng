import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { NavIcon } from './NavIcon'
import styles from './WorkspaceGrid.module.css'

interface Props {
  title: string
  /** Style-variant class already resolved by the grid (accent/flat/outline/elevated). */
  styleClassName: string
  /** Absolute-position + size style computed by the grid (transform/width/height/…). */
  positionStyle: CSSProperties
  minimized: boolean
  dragging: boolean
  onMovePointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onResizePointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onToggleMinimize: () => void
  onHide: () => void
  children: ReactNode
}

/**
 * Presentational card chrome for the dashboard grid: a drag-handle header
 * (⠿ + title + minimize/hide) over a body and a corner resize handle. The body
 * is ALWAYS mounted and merely hidden via `display:none` when minimized — never
 * conditionally unmounted — so a card that owns a live socket/session (Terminal,
 * Chat, Viewers) survives a minimize. Colors come from tokens only.
 */
export function GridCard({
  title,
  styleClassName,
  positionStyle,
  minimized,
  dragging,
  onMovePointerDown,
  onResizePointerDown,
  onToggleMinimize,
  onHide,
  children,
}: Props) {
  return (
    <div
      className={`${styles.card} ${styleClassName} ${dragging ? styles.dragging : ''}`}
      style={positionStyle}
    >
      <div className={styles.header} data-mode="move" onPointerDown={onMovePointerDown}>
        <span className={styles.handle} aria-hidden="true">
          <NavIcon name="grip" />
        </span>
        <span className={styles.title}>{title}</span>
        <button
          type="button"
          className={styles.headerBtn}
          aria-label={minimized ? `Expand ${title}` : `Minimize ${title}`}
          title={minimized ? 'Expand' : 'Minimize'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onToggleMinimize}
        >
          {minimized ? <NavIcon name="square" /> : <NavIcon name="minus" />}
        </button>
        <button
          type="button"
          className={styles.headerBtn}
          aria-label={`Hide ${title}`}
          title="Hide"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onHide}
        >
          <NavIcon name="close" />
        </button>
      </div>

      <div className={styles.body} style={minimized ? { display: 'none' } : undefined}>
        {children}
      </div>

      {!minimized && (
        <div
          className={styles.resize}
          data-mode="resize"
          onPointerDown={onResizePointerDown}
          role="separator"
          aria-label={`Resize ${title}`}
        />
      )}
    </div>
  )
}
