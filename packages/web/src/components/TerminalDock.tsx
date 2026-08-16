import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './TerminalDock.module.css'
import { Terminal } from './Terminal'
import { addTerminal, closeTerminal, emptyDock, setActive } from '../terminalDock'

/** Clamp bounds for the dock height (px). */
const MIN_H = 120
const MAX_H = 640

interface Props {
  /** Whether the dock body is expanded (persisted chrome, from App). */
  open: boolean
  /** Dock body height in px (persisted chrome, from App). */
  height: number
  onOpenChange: (v: boolean) => void
  onHeightChange: (h: number) => void
}

/**
 * The Zed-style bottom terminal dock: a slim always-visible status bar that
 * toggles an expandable body of N terminal tabs. Each tab is a live `<Terminal>`
 * (one PTY / WebSocket per tab). The ephemeral tab list is owned here via the
 * pure `terminalDock` reducer; only `open`/`height` persist (via props). No
 * terminal is mounted while the dock is closed — so no PTY exists.
 */
export function TerminalDock({ open, height, onOpenChange, onHeightChange }: Props) {
  const [dock, setDock] = useState(emptyDock)
  // Monotonic seed for stable, collision-free terminal ids (never Math.random).
  const [seed, setSeed] = useState(0)
  // Tracks the last `open` value we reacted to, so the auto-seed below fires only
  // on the closed→open transition — not on every render while open.
  const [lastOpen, setLastOpen] = useState(false)

  // Auto-create the first terminal only when the dock *transitions* to open with
  // no tabs — covers a fresh toggle-open and a load with the dock persisted open,
  // but NOT the user closing the last tab (that leaves an empty dock, so they can
  // reopen a shell with `+`). Adjusted during render (the "derive state on a prop
  // change" pattern, mirroring WorkspaceView) to avoid react-hooks/set-state-in-effect.
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open && dock.tabs.length === 0) {
      setDock(addTerminal(dock, `term-${seed}`))
      setSeed(seed + 1)
    }
  }

  const spawn = useCallback(() => {
    setDock((d) => addTerminal(d, `term-${seed}`))
    setSeed((s) => s + 1)
  }, [seed])

  // Ctrl+` toggles the dock (Zed parity). Intercepted at the window level;
  // xterm swallows the same chord so it never reaches a focused PTY.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      dragRef.current = { startY: e.clientY, startH: height }
      const onMove = (ev: PointerEvent) => {
        const drag = dragRef.current
        if (!drag) return
        const next = Math.max(MIN_H, Math.min(MAX_H, drag.startH + (drag.startY - ev.clientY)))
        onHeightChange(next)
      }
      const onUp = () => {
        dragRef.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [height, onHeightChange],
  )

  const clampedHeight = Math.max(MIN_H, Math.min(MAX_H, height))

  return (
    <div className={styles.dock}>
      {open && (
        <div className={styles.body} style={{ height: clampedHeight }}>
          <div
            className={styles.resizeHandle}
            onPointerDown={onResizeStart}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize terminal"
          />
          <div className={styles.tabStrip} role="tablist" aria-label="Terminal tabs">
            {dock.tabs.map((t, i) => {
              const active = t.id === dock.activeId
              return (
                <div className={styles.tab} role="presentation" key={t.id}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`${styles.tabLabel} ${active ? styles.tabActive : ''}`}
                    onClick={() => setDock((d) => setActive(d, t.id))}
                  >
                    {`Terminal ${i + 1}`}
                  </button>
                  <button
                    type="button"
                    className={styles.ctrl}
                    aria-label={`Close terminal ${i + 1}`}
                    title="Close"
                    onClick={() => setDock((d) => closeTerminal(d, t.id))}
                  >
                    ×
                  </button>
                </div>
              )
            })}
            <button
              type="button"
              className={styles.add}
              aria-label="New terminal"
              title="New terminal"
              onClick={spawn}
            >
              +
            </button>
          </div>
          <div className={styles.terminals}>
            {dock.tabs.map((t) => (
              <div
                key={t.id}
                className={styles.termHost}
                style={{ display: t.id === dock.activeId ? 'block' : 'none' }}
              >
                <Terminal id={t.id} />
              </div>
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        className={styles.statusBar}
        aria-expanded={open}
        aria-label={open ? 'Hide terminal' : 'Show terminal'}
        onClick={() => onOpenChange(!open)}
      >
        <span className={styles.glyph} aria-hidden="true">
          {'>_'}
        </span>
        <span className={styles.statusLabel}>Terminal</span>
      </button>
    </div>
  )
}
