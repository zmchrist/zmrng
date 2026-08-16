import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './TerminalDock.module.css'
import { Terminal } from './Terminal'
import { addTerminal, closeTerminal, emptyDock, setActive } from '../terminalDock'
import { usePanelMount } from '../usePanelMount'

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
  /** Bottom-nav pane visibility + toggles (the other panes this bar controls). */
  tasksOpen: boolean
  workspaceOpen: boolean
  filesOpen: boolean
  settingsOpen: boolean
  onTasksToggle: () => void
  onWorkspaceToggle: () => void
  onFilesToggle: () => void
  onSettingsToggle: () => void
}

/**
 * The Zed-style bottom bar: a slim always-visible nav bar of pane toggles, plus
 * an expandable terminal body above it. The Terminal button toggles the body of
 * N terminal tabs (each a live `<Terminal>` — one PTY / WebSocket per tab; no
 * terminal is mounted while the dock is closed). The Tasks / Workspace / Settings
 * buttons toggle their regions in place. The ephemeral terminal tab list is owned
 * here via the pure `terminalDock` reducer; only `open`/`height` persist.
 */
export function TerminalDock({
  open,
  height,
  onOpenChange,
  onHeightChange,
  tasksOpen,
  workspaceOpen,
  filesOpen,
  settingsOpen,
  onTasksToggle,
  onWorkspaceToggle,
  onFilesToggle,
  onSettingsToggle,
}: Props) {
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
  const bodyMounted = usePanelMount(open)

  return (
    <div className={styles.dock}>
      {bodyMounted && (
        <div
          className={`${styles.body} ${open ? styles.paneEnter : styles.paneExit}`}
          style={{ height: clampedHeight }}
        >
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
      <div className={styles.navBar} role="toolbar" aria-label="Panes">
        <button
          type="button"
          className={`${styles.navBtn} ${open ? styles.navBtnActive : ''}`}
          aria-pressed={open}
          aria-label={open ? 'Hide terminal' : 'Show terminal'}
          onClick={() => onOpenChange(!open)}
        >
          <span className={styles.glyph} aria-hidden="true">
            {'>_'}
          </span>
          <span className={styles.navLabel}>Terminal</span>
        </button>
        <button
          type="button"
          className={`${styles.navBtn} ${tasksOpen ? styles.navBtnActive : ''}`}
          aria-pressed={tasksOpen}
          aria-label={tasksOpen ? 'Hide tasks' : 'Show tasks'}
          onClick={onTasksToggle}
        >
          <span className={styles.glyph} aria-hidden="true">
            ☰
          </span>
          <span className={styles.navLabel}>Tasks</span>
        </button>
        <button
          type="button"
          className={`${styles.navBtn} ${workspaceOpen ? styles.navBtnActive : ''}`}
          aria-pressed={workspaceOpen}
          aria-label={workspaceOpen ? 'Hide workspace' : 'Show workspace'}
          onClick={onWorkspaceToggle}
        >
          <span className={styles.glyph} aria-hidden="true">
            ▦
          </span>
          <span className={styles.navLabel}>Workspace</span>
        </button>
        <button
          type="button"
          className={`${styles.navBtn} ${filesOpen ? styles.navBtnActive : ''}`}
          aria-pressed={filesOpen}
          aria-label={filesOpen ? 'Hide files' : 'Show files'}
          onClick={onFilesToggle}
        >
          <span className={styles.glyph} aria-hidden="true">
            ⌂
          </span>
          <span className={styles.navLabel}>Files</span>
        </button>
        <button
          type="button"
          className={`${styles.navBtn} ${settingsOpen ? styles.navBtnActive : ''}`}
          aria-pressed={settingsOpen}
          aria-label={settingsOpen ? 'Close settings' : 'Open settings'}
          onClick={onSettingsToggle}
        >
          <span className={styles.glyph} aria-hidden="true">
            ⚙
          </span>
          <span className={styles.navLabel}>Settings</span>
        </button>
      </div>
    </div>
  )
}
