import { useRef } from 'react'
import styles from './PanelHandle.module.css'
import { beginSwipe, resolveSwipe } from '../mobileTaskPanel'
import type { PanelMove, PanelPosition, SwipeGesture } from '../mobileTaskPanel'

const POSITION_TEXT: Record<PanelPosition, string> = {
  list: 'full screen',
  split: 'half screen',
  detail: 'hidden',
}

interface Props {
  /** What the list half is called, e.g. "Task list" — prefixes the accessible name. */
  label: string
  position: PanelPosition
  onMove: (move: PanelMove) => void
}

/**
 * Phone-only swipe handle between a stacked list and its detail. Swipe up steps
 * toward the detail, swipe down toward the list, tap (also the keyboard path)
 * cycles. 44px tall; `touch-action: none` keeps the drag from scrolling the page.
 */
export function PanelHandle({ label, position, onMove }: Props) {
  const swipeRef = useRef<SwipeGesture | null>(null)
  // A touch that already resolved must not be re-applied by the synthetic click
  // the browser fires afterwards; the click path exists for keyboard users.
  const touchHandledRef = useRef(false)
  const name = `${label}: ${POSITION_TEXT[position]}`

  return (
    <button
      type="button"
      className={styles.handle}
      data-position={position}
      aria-label={name}
      title={name}
      onTouchStart={(e) => {
        swipeRef.current = beginSwipe(e.touches[0]?.clientY ?? 0)
      }}
      onTouchEnd={(e) => {
        const gesture = swipeRef.current
        swipeRef.current = null
        if (!gesture) return
        touchHandledRef.current = true
        onMove(resolveSwipe(gesture, e.changedTouches[0]?.clientY ?? gesture.startY))
      }}
      onClick={() => {
        if (touchHandledRef.current) {
          touchHandledRef.current = false
          return
        }
        onMove('tap')
      }}
    >
      <span className={styles.bar} aria-hidden="true" />
    </button>
  )
}
